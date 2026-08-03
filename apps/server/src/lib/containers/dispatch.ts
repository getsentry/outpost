// Shared container setup and prompt dispatch for the Flue harness.
//
// Phase 1: Flue Node server (+ Lore gateway) runs inside the Cloudflare Sandbox
// container. The Worker still orchestrates via sandbox.exec/startProcess.
//
// Phase 2 (see dispatchToFlueAgent in ./flue-dispatch.ts): the agent brain
// moves to a Flue Durable Object; this module only prepares the thin sandbox
// (clone repo, refresh GH auth) and no longer starts a harness process.
//
// IMPORTANT (waitUntil budget): do the MINIMUM fast work in waitUntil (clone,
// write files, start background processes) and let a container-side script
// poll for Flue readiness and send the prompt autonomously.

import type { getSandbox } from "@cloudflare/sandbox"
import type { DrizzleD1Database } from "drizzle-orm/d1"
import type * as dbSchema from "@/db/schema"
import { saveSession } from "./sessions"

/** Flue HTTP port inside the container (Phase 1). */
export const FLUE_PORT = 4096

/** @deprecated Use FLUE_PORT — kept as an alias for any leftover OpenCode references. */
export const OPENCODE_PORT = FLUE_PORT

/** Primary agent identity (Flue mount path /agents/jared). */
export const AGENT = "jared"

/** Conversation URL prefix inside the container. */
export const FLUE_AGENT_MOUNT = `/agents/${AGENT}`

export type SandboxSetupOpts = {
  repo: string | null
  botLogin: string
  installationToken: string
  openrouterApiKey?: string
  anthropicApiKey?: string
  openaiApiKey?: string
  sentryDsn?: string
  entityKey: string
  /** Public base URL of this Worker, so the in-container reporter can POST session data back. */
  appUrl?: string
  /**
   * When true (Phase 2), skip starting Flue/Lore inside the container — the
   * agent brain lives in a Durable Object and the container is a thin sandbox.
   */
  thinSandbox?: boolean
  /** Optional standalone Lore gateway URL (Phase 2). Defaults to in-container Lore. */
  loreGatewayUrl?: string
}

/** Shell-escape a value for safe single-quoted interpolation in bash. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

/**
 * (Re)apply GitHub credentials inside the container.
 *
 * GitHub App installation tokens expire after ~1h, so the agent gets blocked
 * from pushing on long or resumed runs. We re-apply a fresh token on every event.
 */
export async function applyGitHubAuth(
  sandbox: ReturnType<typeof getSandbox>,
  opts: { repo: string | null; installationToken: string },
): Promise<void> {
  const token = opts.installationToken
  if (!token) return

  if (opts.repo) {
    const remoteUrl = `https://x-access-token:${token}@github.com/${opts.repo}.git`
    await sandbox.exec(
      `test -d /workspace/repo/.git && git remote set-url origin ${shellQuote(remoteUrl)} 2>/dev/null || true`,
      { cwd: "/workspace" },
    )
  }

  await sandbox.exec(`echo ${shellQuote(token)} | gh auth login --with-token`, { cwd: "/workspace" })

  await sandbox.exec(
    "touch /tmp/flue-env.sh; " +
      `grep -v '^export GH_TOKEN=' /tmp/flue-env.sh > /tmp/flue-env.sh.tmp 2>/dev/null || true; ` +
      "mv /tmp/flue-env.sh.tmp /tmp/flue-env.sh; " +
      `echo "export GH_TOKEN=${shellQuote(token)}" >> /tmp/flue-env.sh`,
    { cwd: "/workspace" },
  )
}

export async function ensureSandboxReady(
  sandbox: ReturnType<typeof getSandbox>,
  opts: SandboxSetupOpts,
): Promise<void> {
  // Phase 2 thin sandbox: only ensure repo + credentials, no harness process.
  if (opts.thinSandbox) {
    await ensureRepoCloned(sandbox, opts)
    await writeEnvFile(sandbox, opts)
    await applyGitHubAuth(sandbox, opts)
    await ensureWorkspaceSkills(sandbox)
    return
  }

  // Phase 1: check if Flue is already serving.
  let alreadyRunning = false
  try {
    const [procCheck, readyCheck] = await Promise.all([
      sandbox.exec("pgrep -f 'dist/server.mjs|flue' > /dev/null 2>&1", { cwd: "/workspace" }),
      sandbox.exec(
        `curl -sf --max-time 5 http://localhost:${FLUE_PORT}/api/ping >/dev/null 2>&1 || curl -sf --max-time 5 http://localhost:${FLUE_PORT}/health >/dev/null 2>&1`,
        { cwd: "/workspace" },
      ),
    ])
    alreadyRunning = procCheck.success && readyCheck.success
  } catch {
    // Treat as not running.
  }
  if (alreadyRunning) {
    await applyGitHubAuth(sandbox, opts)
    return
  }

  // Kill any stale harness processes (leftover from a previous run/deploy).
  await sandbox.exec(
    "pkill -f 'dist/server.mjs' 2>/dev/null; pkill -f 'lore run' 2>/dev/null; pkill -f 'opencode serve' 2>/dev/null; sleep 1",
    { cwd: "/workspace" },
  )

  await ensureRepoCloned(sandbox, opts)
  await writeEnvFile(sandbox, opts)
  await applyGitHubAuth(sandbox, opts)
  await ensureWorkspaceSkills(sandbox)

  // Start Lore gateway (Phase 1 in-container). Flue model traffic can route through it.
  const loreCmd =
    `bash -c '[ -f /tmp/flue-env.sh ] && . /tmp/flue-env.sh; ` +
    `command -v lore >/dev/null 2>&1 && lore run --port 3207 >> /tmp/lore.log 2>&1 || true'`
  await sandbox.startProcess(loreCmd, { cwd: "/workspace/repo" })

  // Start Flue Node server (non-blocking — dispatch script polls for readiness).
  const startCmd =
    `bash -c '[ -f /tmp/flue-env.sh ] && . /tmp/flue-env.sh; ` +
    `export PORT=${FLUE_PORT}; export LORE_GATEWAY_URL="\${LORE_GATEWAY_URL:-http://127.0.0.1:3207}"; ` +
    `cd /opt/flue && node dist/server.mjs >> /tmp/flue.log 2>&1'`
  await sandbox.startProcess(startCmd, { cwd: "/workspace/repo" })

  // Keepalive so the sandbox does not sleep while Flue works (max 2h).
  const keepaliveScript = [
    "#!/bin/bash",
    "STARTED=$(date +%s)",
    "MAX=7200",
    "while true; do",
    "  sleep 30",
    "  NOW=$(date +%s)",
    "  [ $((NOW - STARTED)) -ge $MAX ] && break",
    "done",
  ].join("\n")
  await sandbox.writeFile("/tmp/keepalive.sh", keepaliveScript)
  await sandbox.startProcess("bash /tmp/keepalive.sh", { cwd: "/workspace" })

  await startSessionReporter(sandbox, { entityKey: opts.entityKey, appUrl: opts.appUrl })
}

async function ensureRepoCloned(
  sandbox: ReturnType<typeof getSandbox>,
  opts: SandboxSetupOpts,
): Promise<void> {
  if (!opts.repo) return

  const checkRepo = await sandbox.exec("test -d /workspace/repo/.git", { cwd: "/workspace" })
  if (!checkRepo.success) {
    const cloneUrl = opts.installationToken
      ? `https://x-access-token:${opts.installationToken}@github.com/${opts.repo}.git`
      : `https://github.com/${opts.repo}.git`
    const cloneResult = await sandbox.exec(`git clone --depth 50 ${cloneUrl} /workspace/repo`, {
      cwd: "/workspace",
    })
    if (!cloneResult.success) throw new Error(`git clone failed: ${cloneResult.stderr}`)
  }

  if (opts.botLogin) {
    const botEmail = `${opts.botLogin}@users.noreply.github.com`
    await sandbox.exec(`git config user.name "${opts.botLogin}" && git config user.email "${botEmail}"`, {
      cwd: "/workspace/repo",
    })
  }
}

async function writeEnvFile(sandbox: ReturnType<typeof getSandbox>, opts: SandboxSetupOpts): Promise<void> {
  const envLines: string[] = []
  if (opts.openrouterApiKey) envLines.push(`export OPENROUTER_API_KEY="${opts.openrouterApiKey}"`)
  if (opts.anthropicApiKey) envLines.push(`export ANTHROPIC_API_KEY="${opts.anthropicApiKey}"`)
  if (opts.openaiApiKey) envLines.push(`export OPENAI_API_KEY="${opts.openaiApiKey}"`)
  if (opts.sentryDsn) envLines.push(`export SENTRY_DSN="${opts.sentryDsn}"`)
  const loreUrl = opts.loreGatewayUrl ?? "http://127.0.0.1:3207"
  envLines.push(`export LORE_GATEWAY_URL="${loreUrl}"`)
  // When Lore is available, point OpenAI-compatible / Anthropic base URLs at it.
  // Harness-specific wiring may also read LORE_GATEWAY_URL directly.
  envLines.push(`export OPENAI_BASE_URL="${loreUrl}/v1"`)
  envLines.push(`export ANTHROPIC_BASE_URL="${loreUrl}"`)
  envLines.push('export FLUE_LOG_LEVEL="debug"')

  await sandbox.writeFile("/tmp/flue-env.sh", `${envLines.join("\n")}\n`)
}

/** Ensure Flue workspace skills exist under /workspace/repo/.agents/skills. */
async function ensureWorkspaceSkills(sandbox: ReturnType<typeof getSandbox>): Promise<void> {
  await sandbox.exec(
    "mkdir -p /workspace/repo/.agents && " +
      "([ -d /opt/flue/.agents/skills ] && cp -R /opt/flue/.agents/skills /workspace/repo/.agents/ || true) && " +
      "([ -f /opt/flue/AGENTS.md ] && cp /opt/flue/AGENTS.md /workspace/repo/AGENTS.md || true) && " +
      "([ -d /root/.agents/skills ] && cp -R /root/.agents/skills /workspace/repo/.agents/ || true)",
    { cwd: "/workspace" },
  )
}

/**
 * Background reporter: polls Flue conversation history and POSTs to
 * POST /api/containers/sessions so the dashboard stays populated.
 */
async function startSessionReporter(
  sandbox: ReturnType<typeof getSandbox>,
  opts: { entityKey: string; appUrl?: string },
): Promise<void> {
  if (!opts.appUrl) return

  const ingestUrl = `${opts.appUrl.replace(/\/$/, "")}/api/containers/sessions`
  const conversationId = opts.entityKey.replace(/[^a-zA-Z0-9_-]/g, "-")

  const reporterScript = [
    "#!/bin/bash",
    "set -u",
    `FLUE="http://localhost:${FLUE_PORT}"`,
    `MOUNT="${FLUE_AGENT_MOUNT}"`,
    `CONV=${shellQuote(conversationId)}`,
    `ENTITY_KEY=${shellQuote(opts.entityKey)}`,
    `INGEST=${shellQuote(ingestUrl)}`,
    "STARTED=$(date +%s)",
    "MAX=7200",
    "",
    "while true; do",
    "  NOW=$(date +%s)",
    "  [ $((NOW - STARTED)) -ge $MAX ] && break",
    "",
    '  HIST=$(curl -sf --max-time 8 "$FLUE$MOUNT/$CONV?view=history" 2>/dev/null)',
    '  if [ -n "$HIST" ]; then',
    '    LOGS=$(tail -100 /tmp/flue.log 2>/dev/null || echo "")',
    "    # Normalize Flue history into the dashboard's {sessions, messages, sessionStatus, logs} blob.",
    `    SESSION_DATA=$(jq -nc --argjson hist "$HIST" --arg logs "$LOGS" --arg sid "$CONV" '{`,
    `      sessions: [{id: $sid, title: $sid, agent: "jared"}],`,
    `      sessionStatus: {($sid): {type: "busy"}},`,
    `      messages: {($sid): (`,
    `        if $hist | type == "object" then`,
    `          ($hist.messages // $hist.records // $hist.items // [])`,
    `        elif $hist | type == "array" then $hist`,
    `        else [] end`,
    `      )},`,
    `      logs: $logs,`,
    `      flue: true`,
    `    }' 2>/dev/null)`,
    '    if [ -n "$SESSION_DATA" ]; then',
    `      BODY=$(jq -nc --arg ek "$ENTITY_KEY" --argjson sd "$SESSION_DATA" '{entityKey: $ek, sessionData: ($sd | tostring)}' 2>/dev/null)`,
    "      # Prefer nested JSON string for sessionData (existing ingest contract).",
    `      BODY=$(jq -nc --arg ek "$ENTITY_KEY" --arg sd "$SESSION_DATA" '{entityKey: $ek, sessionData: $sd}' 2>/dev/null)`,
    `      [ -n "$BODY" ] && curl -sf --max-time 15 -X POST -H 'Content-Type: application/json' -d "$BODY" "$INGEST" >/dev/null 2>&1 || true`,
    "    fi",
    "  fi",
    "  sleep 12",
    "done",
  ].join("\n")

  await sandbox.writeFile("/tmp/session-reporter.sh", reporterScript)
  await sandbox.exec("pkill -f 'session-reporter.sh' 2>/dev/null; sleep 1", { cwd: "/workspace" })
  await sandbox.startProcess("bash /tmp/session-reporter.sh", { cwd: "/workspace" })
}

/**
 * Dispatch a prompt to Flue inside the sandbox (Phase 1).
 *
 * Writes the prompt + a container-side script that polls until Flue is ready,
 * then POSTs `{ kind: "user", body }` to /agents/jared/:conversationId.
 */
export async function dispatchPrompt(
  sandbox: ReturnType<typeof getSandbox>,
  containerKey: string,
  prompt: string,
  eventId: string,
): Promise<void> {
  const conversationId = containerKey.replace(/[^a-zA-Z0-9_-]/g, "-")
  const promptPayload = JSON.stringify({ kind: "user", body: prompt })
  const promptFile = `/tmp/prompt-${eventId}.json`
  await sandbox.writeFile(promptFile, promptPayload)

  const dispatchScript = [
    "#!/bin/bash",
    "set -u",
    `FLUE="http://localhost:${FLUE_PORT}"`,
    `MOUNT="${FLUE_AGENT_MOUNT}"`,
    `CONV=${shellQuote(conversationId)}`,
    `PROMPT_FILE="${promptFile}"`,
    "",
    "# Wait for Flue to be ready (up to 180s).",
    "for i in $(seq 1 180); do",
    '  curl -sf --max-time 2 "$FLUE/api/ping" >/dev/null 2>&1 && break',
    '  curl -sf --max-time 2 "$FLUE/health" >/dev/null 2>&1 && break',
    "  sleep 1",
    "done",
    "",
    'echo "$CONV" > /tmp/dispatch-session-id',
    "",
    "# Admit the prompt (202). Flue processes asynchronously.",
    'curl -sf -X POST -H "Content-Type: application/json" -d @"$PROMPT_FILE" "$FLUE$MOUNT/$CONV"',
  ].join("\n")

  const scriptFile = `/tmp/dispatch-${eventId}.sh`
  await sandbox.writeFile(scriptFile, dispatchScript)
  await sandbox.startProcess(`bash ${scriptFile}`, { cwd: "/workspace" })
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
    sessions: [{ id: sessionId, title: containerKey, agent: AGENT }],
    logs: "",
    messages: {},
    flue: true,
  })
  await saveSession(db, containerKey, initialData)
}
