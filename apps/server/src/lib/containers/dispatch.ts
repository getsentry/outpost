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
export type SandboxSetupOpts = {
  repo: string | null
  botLogin: string
  installationToken: string
  anthropicApiKey?: string
  openaiApiKey?: string
  sentryDsn?: string
  entityKey: string
  /** Public base URL of this Worker, so the in-container reporter can POST session data back. */
  appUrl?: string
}

/** Shell-escape a value for safe single-quoted interpolation in bash. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

/**
 * (Re)apply GitHub credentials inside the container.
 *
 * GitHub App installation tokens expire after ~1h, so the agent gets blocked
 * from pushing on long or resumed runs. We re-apply a fresh token on every event
 * (both warm and cold sandbox paths) and on demand via the refresh endpoint:
 *   - point the repo remote at an authenticated URL,
 *   - re-run `gh auth login` so the `gh` CLI uses the new token,
 *   - rewrite GH_TOKEN in the env file consumed by future processes.
 *
 * Safe to call repeatedly; a no-op when no token is provided.
 */
export async function applyGitHubAuth(
  sandbox: ReturnType<typeof getSandbox>,
  opts: { repo: string | null; installationToken: string },
): Promise<void> {
  const token = opts.installationToken
  if (!token) return

  if (opts.repo) {
    const remoteUrl = `https://x-access-token:${token}@github.com/${opts.repo}.git`
    // Only touch the remote when the repo is already cloned; clone happens elsewhere.
    await sandbox.exec(
      `test -d /workspace/repo/.git && git remote set-url origin ${shellQuote(remoteUrl)} 2>/dev/null || true`,
      { cwd: "/workspace" },
    )
  }

  // `gh auth login --with-token` is idempotent and replaces any prior token.
  await sandbox.exec(`echo ${shellQuote(token)} | gh auth login --with-token`, { cwd: "/workspace" })

  // Rewrite GH_TOKEN in the env file so newly-started processes pick it up.
  await sandbox.exec(
    "touch /tmp/opencode-env.sh; " +
      `grep -v '^export GH_TOKEN=' /tmp/opencode-env.sh > /tmp/opencode-env.sh.tmp 2>/dev/null || true; ` +
      "mv /tmp/opencode-env.sh.tmp /tmp/opencode-env.sh; " +
      `echo "export GH_TOKEN=${shellQuote(token)}" >> /tmp/opencode-env.sh`,
    { cwd: "/workspace" },
  )
}

export async function ensureSandboxReady(
  sandbox: ReturnType<typeof getSandbox>,
  opts: SandboxSetupOpts,
): Promise<void> {
  // Check if OpenCode is already running (fast path).
  //
  // CRITICAL: probe readiness against an endpoint that actually exists on
  // OpenCode v1.17.0 (`/session`, the same one the dispatch script polls). The
  // old check hit `/global/health`/`/api/health`, which 404 on v1.17.0, so the
  // fast path NEVER triggered — meaning every follow-up event would pkill a
  // running `opencode serve` and abort the agent's in-flight generation
  // (assistant message left with empty parts). We only restart when OpenCode is
  // genuinely absent or unresponsive.
  let alreadyRunning = false
  try {
    const [procCheck, readyCheck] = await Promise.all([
      sandbox.exec("pgrep -f 'opencode serve' > /dev/null 2>&1", { cwd: "/workspace" }),
      sandbox.exec(
        `curl -sf --max-time 5 http://localhost:${OPENCODE_PORT}/session >/dev/null 2>&1 || curl -sf --max-time 5 http://localhost:${OPENCODE_PORT}/api/session >/dev/null 2>&1`,
        { cwd: "/workspace" },
      ),
    ])
    alreadyRunning = procCheck.success && readyCheck.success
  } catch {
    // Treat as not running.
  }
  if (alreadyRunning) {
    // OpenCode is already serving — don't restart it (that would abort an
    // in-flight generation). But the installation token may have expired since
    // the last event, so always re-apply fresh credentials before returning.
    await applyGitHubAuth(sandbox, opts)
    return
  }

  // Kill any stale OpenCode processes (leftover from a previous run/deploy).
  // Only reached when OpenCode is NOT serving, so this never aborts a live agent.
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
  }

  // Write env file (everything except GH_TOKEN, which applyGitHubAuth manages so
  // the same logic handles initial setup and later refreshes).
  const envLines: string[] = []
  if (opts.anthropicApiKey) envLines.push(`export ANTHROPIC_API_KEY="${opts.anthropicApiKey}"`)
  if (opts.openaiApiKey) envLines.push(`export OPENAI_API_KEY="${opts.openaiApiKey}"`)
  if (opts.sentryDsn) envLines.push(`export SENTRY_DSN="${opts.sentryDsn}"`)
  envLines.push('export OPENCODE_LOG_LEVEL="debug"')

  await sandbox.writeFile("/tmp/opencode-env.sh", `${envLines.join("\n")}\n`)

  // Apply GitHub credentials (sets the remote URL, gh auth, and GH_TOKEN).
  await applyGitHubAuth(sandbox, opts)

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

  // Start the session reporter so messages/cost are pushed back to the server
  // continuously — even if nobody opens the detail page and even after the
  // container later sleeps (the last push is durable in D1).
  await startSessionReporter(sandbox, { entityKey: opts.entityKey, appUrl: opts.appUrl })
}

/**
 * Start a background, in-container reporter that periodically pushes the live
 * OpenCode session data back to the server's unauthenticated ingest endpoint
 * (POST /api/containers/sessions). This is the durable, push-based replacement
 * for the UI-gated pull sync: it works without anyone viewing the container and
 * persists the final state before the container sleeps.
 *
 * Idempotent — kills any previous reporter before starting a new one.
 */
async function startSessionReporter(
  sandbox: ReturnType<typeof getSandbox>,
  opts: { entityKey: string; appUrl?: string },
): Promise<void> {
  if (!opts.appUrl) return // No public URL to report to — skip silently.

  const ingestUrl = `${opts.appUrl.replace(/\/$/, "")}/api/containers/sessions`

  // The reporter mirrors collectContainerData(): list sessions, fetch each
  // session's messages + status + logs, assemble the same { sessions,
  // sessionStatus, messages, logs } blob, and POST it wrapped as
  // { entityKey, sessionData }. saveSession() merges by message id server-side.
  const reporterScript = [
    "#!/bin/bash",
    "set -u",
    `OC="http://localhost:${OPENCODE_PORT}"`,
    `ENTITY_KEY=${shellQuote(opts.entityKey)}`,
    `INGEST=${shellQuote(ingestUrl)}`,
    "STARTED=$(date +%s)",
    "MAX=7200",
    "",
    "while true; do",
    "  NOW=$(date +%s)",
    "  [ $((NOW - STARTED)) -ge $MAX ] && break",
    "",
    '  SESSIONS=$(curl -sf --max-time 8 "$OC/session" 2>/dev/null)',
    '  if [ -n "$SESSIONS" ]; then',
    '    STATUS=$(curl -sf --max-time 8 "$OC/session/status" 2>/dev/null || echo "{}")',
    '    LOGS=$(tail -100 /tmp/opencode.log 2>/dev/null || echo "")',
    "    # Build the messages map keyed by session id (capped at 25 sessions).",
    `    IDS=$(printf '%s' "$SESSIONS" | jq -r 'if type=="array" then .[] else .data[] end | .id' 2>/dev/null | head -25)`,
    '    MSG_OBJ="{}"',
    "    for SID in $IDS; do",
    '      MSGS=$(curl -sf --max-time 12 "$OC/session/$SID/message?limit=50" 2>/dev/null || echo "[]")',
    `      MSG_OBJ=$(printf '%s' "$MSG_OBJ" | jq --arg sid "$SID" --argjson msgs "$(printf '%s' "$MSGS" | jq 'if type=="array" then . else (.data // []) end' 2>/dev/null || echo '[]')" '.[$sid] = $msgs' 2>/dev/null || printf '%s' "$MSG_OBJ")`,
    "    done",
    "    # Assemble the sessionData blob and the POST body.",
    `    SESSIONS_ARR=$(printf '%s' "$SESSIONS" | jq 'if type=="array" then . else (.data // []) end' 2>/dev/null || echo '[]')`,
    `    SESSION_DATA=$(jq -nc --argjson sessions "$SESSIONS_ARR" --argjson status "$STATUS" --argjson messages "$MSG_OBJ" --arg logs "$LOGS" '{sessions: $sessions, sessionStatus: $status, messages: $messages, logs: $logs}' 2>/dev/null)`,
    '    if [ -n "$SESSION_DATA" ]; then',
    `      BODY=$(jq -nc --arg ek "$ENTITY_KEY" --arg sd "$SESSION_DATA" '{entityKey: $ek, sessionData: $sd}' 2>/dev/null)`,
    `      [ -n "$BODY" ] && curl -sf --max-time 15 -X POST -H 'Content-Type: application/json' -d "$BODY" "$INGEST" >/dev/null 2>&1 || true`,
    "    fi",
    "  fi",
    "  sleep 12",
    "done",
  ].join("\n")

  await sandbox.writeFile("/tmp/session-reporter.sh", reporterScript)
  // Kill any prior reporter so only one runs at a time, then start fresh.
  await sandbox.exec("pkill -f 'session-reporter.sh' 2>/dev/null; sleep 1", { cwd: "/workspace" })
  await sandbox.startProcess("bash /tmp/session-reporter.sh", { cwd: "/workspace" })
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
