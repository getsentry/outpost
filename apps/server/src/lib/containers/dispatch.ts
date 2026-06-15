// Shared container setup and prompt dispatch logic.
// Used by both the GitHub and Sentry webhook handlers to start
// containers and send prompts to the OpenCode agent.
//
// IMPORTANT (waitUntil budget): the Worker's waitUntil context cannot be relied
// on to stay alive through a cold container boot + OpenCode's ~30-40s startup.
// So we do the MINIMUM fast work in waitUntil (clone, write files, start
// background processes) and let a container-side script poll for OpenCode
// readiness and send the prompt autonomously. This is robust for cold starts.

import type { getSandbox } from "@cloudflare/sandbox"
import type { DrizzleD1Database } from "drizzle-orm/d1"
import type * as dbSchema from "@/db/schema"
import { saveSession } from "./sessions"

export const OPENCODE_PORT = 4096

/** The agent that handles all dispatched prompts. */
export const AGENT = "jared"

/**
 * Set up the sandbox: clone repo, configure git, start OpenCode.
 * Idempotent — safe to call on every event.
 *
 * Does NOT block on OpenCode becoming ready (no waitForPort): OpenCode can take
 * 30-40s to serve requests, and blocking here would exhaust the waitUntil
 * budget. The dispatch script (see dispatchPrompt) polls for readiness instead.
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

  // Start OpenCode (non-blocking — do not waitForPort; the dispatch script polls).
  const cwd = opts.repo ? "/workspace/repo" : "/workspace"
  const startCmd = `bash -c '[ -f /tmp/opencode-env.sh ] && . /tmp/opencode-env.sh; opencode serve --port ${OPENCODE_PORT} --hostname 0.0.0.0 >> /tmp/opencode.log 2>&1'`
  await sandbox.startProcess(startCmd, { cwd })

  // Start a keepalive process that keeps the sandbox alive while OpenCode works.
  const keepaliveScript = [
    "#!/bin/bash",
    `PORT=${OPENCODE_PORT}`,
    "STARTED=$(date +%s)",
    "MAX=7200",
    "",
    "while true; do",
    "  sleep 30",
    "  NOW=$(date +%s)",
    "  [ $((NOW - STARTED)) -ge $MAX ] && break",
    "done",
  ].join("\n")
  await sandbox.writeFile("/tmp/keepalive.sh", keepaliveScript)
  await sandbox.startProcess("bash /tmp/keepalive.sh", { cwd: "/workspace" })
}

/**
 * Dispatch a prompt to OpenCode inside the sandbox.
 *
 * This does NOT wait for OpenCode or send the prompt synchronously (that would
 * block the Worker's waitUntil through OpenCode's slow startup). Instead it
 * writes the prompt payload + a small dispatch script to the container and
 * starts that script in the background. The script polls for OpenCode
 * readiness, finds/creates the root session, and sends the prompt with the
 * "${AGENT}" agent — all autonomously inside the container.
 *
 * Verified against OpenCode v1.17.0:
 *   - /session/:id/prompt_async  → 204, ACTUALLY processes (correct endpoint)
 *   - /api/session/:id/prompt    → fallback for v1.17.4+
 *   - Payload MUST be { agent, parts: [...] }; { prompt: { text } } is ignored.
 *   - A plain /session/:id/prompt (no /api/, no _async) does NOT exist on
 *     v1.17.0 — it hits a catch-all returning 200 without processing.
 */
export async function dispatchPrompt(
  sandbox: ReturnType<typeof getSandbox>,
  containerKey: string,
  prompt: string,
  eventId: string,
): Promise<void> {
  // Prompt payload — the "${AGENT}" agent handles every dispatched prompt.
  const promptPayload = JSON.stringify({ agent: AGENT, parts: [{ type: "text", text: prompt }] })
  const promptFile = `/tmp/prompt-${eventId}.json`
  await sandbox.writeFile(promptFile, promptPayload)

  // Session title carries the entity key; escape any single quotes for bash.
  const safeTitle = containerKey.replace(/'/g, "'\\''")

  // Container-side dispatch script: waits for OpenCode, finds/creates the root
  // session, and sends the prompt. Runs in the background, decoupled from the
  // Worker's waitUntil budget.
  const dispatchScript = [
    "#!/bin/bash",
    "set -u",
    `OC="http://localhost:${OPENCODE_PORT}"`,
    `PROMPT_FILE="${promptFile}"`,
    `TITLE='${safeTitle}'`,
    "",
    "# Wait for OpenCode to be ready (up to 180s).",
    "for i in $(seq 1 180); do",
    '  curl -sf --max-time 2 "$OC/session" >/dev/null 2>&1 && break',
    '  curl -sf --max-time 2 "$OC/api/session" >/dev/null 2>&1 && break',
    "  sleep 1",
    "done",
    "",
    "# Find the root session (no parentID) or create one.",
    'LIST=$(curl -sf "$OC/session" 2>/dev/null || curl -sf "$OC/api/session" 2>/dev/null)',
    `SID=$(printf '%s' "$LIST" | jq -r 'if type=="array" then ((map(select(.parentID==null)) + .)[0].id) else (.data[0].id) end' 2>/dev/null)`,
    'if [ -z "$SID" ] || [ "$SID" = "null" ]; then',
    `  CREATED=$(curl -sf -X POST -H 'Content-Type: application/json' -d "{\\"title\\":\\"$TITLE\\"}" "$OC/session" 2>/dev/null || curl -sf -X POST -H 'Content-Type: application/json' -d "{\\"title\\":\\"$TITLE\\"}" "$OC/api/session" 2>/dev/null)`,
    `  SID=$(printf '%s' "$CREATED" | jq -r '.id // .data.id' 2>/dev/null)`,
    "fi",
    'echo "$SID" > /tmp/dispatch-session-id',
    "",
    "# Send the prompt (agent is embedded in the payload). Try async (v1.17.0)",
    "# first, then /api prompt (v1.17.4+).",
    'curl -sf -X POST -H "Content-Type: application/json" -d @"$PROMPT_FILE" "$OC/session/$SID/prompt_async" 2>/dev/null \\',
    '  || curl -sf -X POST -H "Content-Type: application/json" -d @"$PROMPT_FILE" "$OC/api/session/$SID/prompt" 2>/dev/null',
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
    sessions: [{ id: sessionId, title: containerKey }],
    logs: "",
    messages: {},
  })
  await saveSession(db, containerKey, initialData)
}
