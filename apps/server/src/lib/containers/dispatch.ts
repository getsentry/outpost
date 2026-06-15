// Shared container setup and prompt dispatch logic.
// Used by both the GitHub and Sentry webhook handlers to start
// containers and send prompts to the OpenCode agent.

import type { getSandbox } from "@cloudflare/sandbox"
import type { DrizzleD1Database } from "drizzle-orm/d1"
import type * as dbSchema from "@/db/schema"
import { saveSession } from "./sessions"

export const OPENCODE_PORT = 4096

/** Default timeout for sandbox setup (2 minutes). */
const SANDBOX_READY_TIMEOUT_MS = 120_000

/**
 * Wrap a promise with a timeout. Rejects with a descriptive error if the
 * promise doesn't settle within `ms` milliseconds.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

/**
 * Set up the sandbox: clone repo, configure git, start OpenCode.
 * Idempotent — safe to call on every event.
 * Wrapped with a timeout to prevent indefinite hangs inside waitUntil.
 */
export async function ensureSandboxReady(
  sandbox: ReturnType<typeof getSandbox>,
  opts: {
    repo: string | null
    botLogin: string
    installationToken: string
    anthropicApiKey?: string
    openaiApiKey?: string
    sentryDsn?: string
    entityKey: string
  },
): Promise<void> {
  return withTimeout(ensureSandboxReadyInner(sandbox, opts), SANDBOX_READY_TIMEOUT_MS, "ensureSandboxReady")
}

async function ensureSandboxReadyInner(
  sandbox: ReturnType<typeof getSandbox>,
  opts: {
    repo: string | null
    botLogin: string
    installationToken: string
    anthropicApiKey?: string
    openaiApiKey?: string
    sentryDsn?: string
    entityKey: string
  },
): Promise<void> {
  // Check if OpenCode is already running (fast path).
  try {
    const [healthCheck, procCheck] = await Promise.all([
      sandbox.exec(
        `curl -sf http://localhost:${OPENCODE_PORT}/global/health 2>/dev/null || curl -sf http://localhost:${OPENCODE_PORT}/api/health 2>/dev/null`,
        { cwd: "/workspace" },
      ),
      sandbox.exec("pgrep -f 'opencode serve' > /dev/null 2>&1", { cwd: "/workspace" }),
    ])
    if (healthCheck.success && procCheck.success) return
  } catch {
    // Not running
  }

  // Kill any stale OpenCode processes (leftover from a previous run/deploy)
  await sandbox.exec("pkill -f 'opencode serve' 2>/dev/null; sleep 1", { cwd: "/workspace" })

  // Clone repo if needed
  if (opts.repo) {
    const checkRepo = await sandbox.exec("test -d /workspace/repo/.git", { cwd: "/workspace" })
    if (!checkRepo.success) {
      const cloneUrl = opts.installationToken
        ? `https://x-access-token:${opts.installationToken}@github.com/${opts.repo}.git`
        : `https://github.com/${opts.repo}.git`
      const cloneResult = await sandbox.exec(`git clone --depth 50 ${cloneUrl} /workspace/repo`, { cwd: "/workspace" })
      if (!cloneResult.success) throw new Error(`git clone failed: ${cloneResult.stderr}`)
    }

    if (opts.botLogin) {
      const botEmail = `${opts.botLogin}@users.noreply.github.com`
      await sandbox.exec(`git config user.name "${opts.botLogin}" && git config user.email "${botEmail}"`, {
        cwd: "/workspace/repo",
      })
    }

    if (opts.installationToken) {
      await sandbox.exec(`echo "${opts.installationToken}" | gh auth login --with-token`, { cwd: "/workspace/repo" })
    }
  }

  // Write env file
  const envLines: string[] = []
  if (opts.installationToken) envLines.push(`export GH_TOKEN="${opts.installationToken}"`)
  if (opts.anthropicApiKey) envLines.push(`export ANTHROPIC_API_KEY="${opts.anthropicApiKey}"`)
  if (opts.openaiApiKey) envLines.push(`export OPENAI_API_KEY="${opts.openaiApiKey}"`)
  if (opts.sentryDsn) envLines.push(`export SENTRY_DSN="${opts.sentryDsn}"`)
  envLines.push('export OPENCODE_LOG_LEVEL="debug"')

  await sandbox.writeFile("/tmp/opencode-env.sh", `${envLines.join("\n")}\n`)

  // Start OpenCode with logs redirected to a file for debugging
  const cwd = opts.repo ? "/workspace/repo" : "/workspace"
  const startCmd = `bash -c '[ -f /tmp/opencode-env.sh ] && . /tmp/opencode-env.sh; opencode serve --port ${OPENCODE_PORT} --hostname 0.0.0.0 >> /tmp/opencode.log 2>&1'`
  const proc = await sandbox.startProcess(startCmd, { cwd })
  await proc.waitForPort(OPENCODE_PORT)

  // Start a keepalive process that keeps the sandbox alive while OpenCode works.
  const keepaliveScript = [
    "#!/bin/bash",
    `PORT=${OPENCODE_PORT}`,
    "STARTED=$(date +%s)",
    "MAX=7200",
    "",
    "while true; do",
    "  sleep 30",
    "  curl -sf http://localhost:$PORT/global/health > /dev/null 2>&1 || break",
    "  NOW=$(date +%s)",
    "  [ $((NOW - STARTED)) -ge $MAX ] && break",
    "done",
  ].join("\n")
  await sandbox.writeFile("/tmp/keepalive.sh", keepaliveScript)
  await sandbox.startProcess("bash /tmp/keepalive.sh", { cwd: "/workspace" })
}

/**
 * Dispatch a prompt to OpenCode inside the sandbox.
 * Uses curl with fallback for both v1.17.0 and v1.17.4+ API formats.
 */
export async function dispatchPrompt(
  sandbox: ReturnType<typeof getSandbox>,
  containerKey: string,
  prompt: string,
  eventId: string,
): Promise<string> {
  const OC = `http://localhost:${OPENCODE_PORT}`

  // Find or create session — try both old (flat array) and new ({ data: [...] }) formats
  const listResult = await sandbox.exec(
    `curl -sf ${OC}/session 2>/dev/null || curl -sf ${OC}/api/session 2>/dev/null`,
    { cwd: "/workspace" },
  )
  let sessionId: string | null = null

  if (listResult.success && listResult.stdout) {
    try {
      const raw = JSON.parse(listResult.stdout)
      const sessions = (Array.isArray(raw) ? raw : (raw.data ?? [])) as Array<{ id: string; parentID?: string }>
      // Prefer root session (no parentID) — child sessions are subagents
      const rootSession = sessions.find((s) => !s.parentID)
      if (rootSession) {
        sessionId = rootSession.id
      } else if (sessions.length > 0) {
        sessionId = sessions[0].id
      }
    } catch {
      /* empty */
    }
  }

  if (!sessionId) {
    const body = JSON.stringify({ title: containerKey })
    const createResult = await sandbox.exec(
      `curl -sf -X POST -H 'Content-Type: application/json' -d '${body.replace(/'/g, "'\\''")}' ${OC}/session 2>/dev/null || curl -sf -X POST -H 'Content-Type: application/json' -d '${body.replace(/'/g, "'\\''")}' ${OC}/api/session 2>/dev/null`,
      { cwd: "/workspace" },
    )
    if (createResult.success && createResult.stdout) {
      try {
        const raw = JSON.parse(createResult.stdout)
        sessionId = raw.id ?? raw.data?.id ?? null
      } catch {
        /* empty */
      }
    }
  }

  if (!sessionId) throw new Error("failed to find or create session")

  // Write prompt to file to avoid shell escaping issues
  const promptPayload = JSON.stringify({ agent: "jared", prompt: { text: prompt } })
  const promptFile = `/tmp/prompt-${eventId}.json`
  await sandbox.writeFile(promptFile, promptPayload)

  // Try prompt endpoints in order of reliability:
  // 1. /api/session/:id/prompt  — v1.17.4+ (preferred, actually processes)
  // 2. /session/:id/prompt      — v1.17.0 (no /api/ prefix, actually processes)
  // 3. /session/:id/prompt_async — v1.17.0 last resort (may return 204 without processing)
  // IMPORTANT: prompt_async on v1.17.0 returns 204 but silently drops the prompt,
  // so it must NOT be tried first — its success masks the real failure.
  const promptResult = await sandbox.exec(
    `curl -sf -X POST -H 'Content-Type: application/json' -d @${promptFile} ${OC}/api/session/${sessionId}/prompt 2>/dev/null || curl -sf -X POST -H 'Content-Type: application/json' -d @${promptFile} ${OC}/session/${sessionId}/prompt 2>/dev/null || curl -sf -X POST -H 'Content-Type: application/json' -d @${promptFile} ${OC}/session/${sessionId}/prompt_async 2>/dev/null`,
    { cwd: "/workspace" },
  )
  await sandbox.exec(`rm -f ${promptFile}`, { cwd: "/workspace" })

  if (!promptResult.success) throw new Error(`prompt dispatch failed: ${promptResult.stderr}`)
  return sessionId
}

/**
 * Save an initial session record to D1 so the container appears immediately.
 */
export async function saveInitialSession(
  db: DrizzleD1Database<typeof dbSchema>,
  containerKey: string,
  sessionId: string,
): Promise<void> {
  const initialData = JSON.stringify({
    sessionStatus: { [sessionId]: { type: "busy" } },
    sessions: [{ id: sessionId, title: containerKey }],
    logs: "",
    messages: {},
  })
  await saveSession(db, containerKey, initialData)
}
