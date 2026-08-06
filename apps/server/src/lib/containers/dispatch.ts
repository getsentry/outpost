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
import { FLUE_INTERNAL_HEADER, resolveFlueInternalToken } from "@/middlewares/flue-auth"
import { toAgentInstanceId } from "./ids"
import { mintSessionIngestToken } from "./session-ingest-token"
import { saveSession } from "./sessions"

/** Flue HTTP port inside the container (Phase 1). */
export const FLUE_PORT = 4096

/** @deprecated Use FLUE_PORT — kept as an alias for any leftover OpenCode references. */
export const OPENCODE_PORT = FLUE_PORT

/** Primary agent identity (Flue mount path /agents/jared). */
export const AGENT = "jared"

/** Conversation URL prefix inside the container. */
export const FLUE_AGENT_MOUNT = `/agents/${AGENT}`

/** @deprecated Prefer {@link toAgentInstanceId}. */
export function sanitizeConversationId(entityKey: string): string {
  return toAgentInstanceId(entityKey)
}

export type SandboxSetupOpts = {
  repo: string | null
  botLogin: string
  installationToken: string
  openrouterApiKey?: string
  anthropicApiKey?: string
  openaiApiKey?: string
  sentryDsn?: string
  /** Auth token for the in-sandbox `sentry` CLI (issue/trace debugging). */
  sentryAuthToken?: string
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
  /** Shared secret used to mint per-entity session-ingest tokens (never written raw into the sandbox). */
  flueInternalToken?: string
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
      sandbox.exec("pgrep -f 'node dist/server.mjs' > /dev/null 2>&1", { cwd: "/workspace" }),
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
    // Warm path: refresh env + ensure the session reporter is still alive.
    await writeEnvFile(sandbox, opts)
    await ensureSessionReporterRunning(sandbox, {
      entityKey: opts.entityKey,
      appUrl: opts.appUrl,
      flueInternalToken: opts.flueInternalToken,
    })
    return
  }

  // Cold start. CRITICAL: the Worker only writes files and kicks off ONE detached
  // bootstrap script, then returns. All the slow work (container cold-start,
  // `git clone`, Lore probe, starting Flue) happens container-side so the Worker
  // `waitUntil` budget can never evict us mid-setup and leave Flue unstarted.
  await writeEnvFile(sandbox, opts)
  await sandbox.writeFile("/tmp/flue-bootstrap.sh", buildPhase1BootstrapScript(opts))
  await sandbox.startProcess("bash /tmp/flue-bootstrap.sh", { cwd: "/workspace" })

  // The reporter mints its own entity-scoped token, so keep it Worker-side; it is
  // fast (writeFile + startProcess) and safe to run before the bootstrap finishes
  // — it simply polls until Flue answers.
  await startSessionReporter(sandbox, {
    entityKey: opts.entityKey,
    appUrl: opts.appUrl,
    flueInternalToken: opts.flueInternalToken,
  })
}

/**
 * Build the Phase 1 cold-start bootstrap. Runs entirely inside the container as a
 * single detached process so the Worker never blocks on `git clone`/cold-start.
 *
 * Steps: kill stale harnesses → clone repo → git identity + GH auth → copy
 * skills → start Lore (and enable provider base URLs only if healthy) → start
 * Flue → keepalive. The separate dispatch script (see dispatchPrompt) waits up
 * to 180s for Flue readiness before admitting the prompt, so ordering here only
 * needs to be internally consistent, not synchronized with the Worker.
 */
export function buildPhase1BootstrapScript(opts: SandboxSetupOpts): string {
  const repo = opts.repo ?? ""
  const token = opts.installationToken ?? ""
  const cloneUrl = token ? `https://x-access-token:${token}@github.com/${repo}.git` : `https://github.com/${repo}.git`
  const remoteUrl = cloneUrl
  const botLogin = opts.botLogin ?? ""
  const botEmail = botLogin ? `${botLogin}@users.noreply.github.com` : ""

  return [
    "#!/bin/bash",
    "set -u",
    `REPO=${shellQuote(repo)}`,
    `TOKEN=${shellQuote(token)}`,
    `CLONE_URL=${shellQuote(cloneUrl)}`,
    `REMOTE_URL=${shellQuote(remoteUrl)}`,
    `BOT_LOGIN=${shellQuote(botLogin)}`,
    `BOT_EMAIL=${shellQuote(botEmail)}`,
    `FLUE_PORT=${FLUE_PORT}`,
    "",
    "# Kill any stale harness processes (leftover from a previous run/deploy).",
    "pkill -f 'dist/server.mjs' 2>/dev/null; pkill -f 'lore run' 2>/dev/null; pkill -f 'opencode serve' 2>/dev/null",
    "sleep 1",
    "",
    "# Clone the repo (temp dir + atomic rename so a partial clone never blocks",
    "# the next attempt). mv into a non-existent dest to avoid nesting.",
    'if [ -n "$REPO" ] && [ ! -d /workspace/repo/.git ]; then',
    "  rm -rf /workspace/repo /workspace/repo-tmp",
    "  mkdir -p /workspace",
    '  if git clone --depth 50 "$CLONE_URL" /workspace/repo-tmp; then',
    "    mv /workspace/repo-tmp /workspace/repo",
    "  else",
    '    echo "git clone failed" >> /tmp/flue-bootstrap.log',
    "    rm -rf /workspace/repo-tmp",
    "  fi",
    "fi",
    "",
    "# Git identity for the bot.",
    'if [ -n "$BOT_LOGIN" ] && [ -d /workspace/repo/.git ]; then',
    '  git -C /workspace/repo config user.name "$BOT_LOGIN"',
    '  git -C /workspace/repo config user.email "$BOT_EMAIL"',
    "fi",
    "",
    "# GitHub auth: gh CLI + authenticated remote + GH_TOKEN in the Flue env.",
    'if [ -n "$TOKEN" ]; then',
    '  echo "$TOKEN" | gh auth login --with-token 2>/dev/null || true',
    '  [ -d /workspace/repo/.git ] && git -C /workspace/repo remote set-url origin "$REMOTE_URL" 2>/dev/null || true',
    "  touch /tmp/flue-env.sh",
    "  grep -v '^export GH_TOKEN=' /tmp/flue-env.sh > /tmp/flue-env.sh.tmp 2>/dev/null || true",
    "  mv /tmp/flue-env.sh.tmp /tmp/flue-env.sh 2>/dev/null || true",
    "  echo \"export GH_TOKEN='$TOKEN'\" >> /tmp/flue-env.sh",
    "fi",
    "",
    "# Copy workspace skills into the clone (source of truth lives outside it).",
    "mkdir -p /workspace/repo/.agents",
    "[ -d /root/.agents/skills ] && cp -R /root/.agents/skills /workspace/repo/.agents/ 2>/dev/null || true",
    "[ -f /root/AGENTS.md ] && cp /root/AGENTS.md /workspace/repo/AGENTS.md 2>/dev/null || true",
    "[ -d /opt/flue/.agents/skills ] && cp -R /opt/flue/.agents/skills /workspace/repo/.agents/ 2>/dev/null || true",
    "[ -f /opt/flue/AGENTS.md ] && cp /opt/flue/AGENTS.md /workspace/repo/AGENTS.md 2>/dev/null || true",
    "",
    "# Start Lore gateway; only route provider traffic through it once healthy.",
    "# The withlore installer drops the binary in ~/.local/bin, which is not on",
    "# PATH for this non-login shell — add it so `command -v lore` can find it.",
    'export PATH="$HOME/.local/bin:$PATH"',
    "if command -v lore >/dev/null 2>&1; then",
    "  ( [ -f /tmp/flue-env.sh ] && . /tmp/flue-env.sh; lore run --port 3207 >> /tmp/lore.log 2>&1 ) &",
    "  for i in $(seq 1 10); do",
    "    if curl -sf --max-time 2 http://127.0.0.1:3207/health >/dev/null 2>&1; then",
    "      grep -v '^export OPENAI_BASE_URL=' /tmp/flue-env.sh | grep -v '^export ANTHROPIC_BASE_URL=' > /tmp/flue-env.sh.tmp 2>/dev/null || true",
    "      mv /tmp/flue-env.sh.tmp /tmp/flue-env.sh 2>/dev/null || true",
    `      echo "export OPENAI_BASE_URL='http://127.0.0.1:3207/v1'" >> /tmp/flue-env.sh`,
    `      echo "export ANTHROPIC_BASE_URL='http://127.0.0.1:3207'" >> /tmp/flue-env.sh`,
    "      break",
    "    fi",
    "    sleep 1",
    "  done",
    "else",
    '  echo "lore binary missing" >> /tmp/lore.log',
    "fi",
    "",
    "# Start the Flue Node server (background; dispatch script polls readiness).",
    "( [ -f /tmp/flue-env.sh ] && . /tmp/flue-env.sh; export PORT=$FLUE_PORT; cd /opt/flue && node dist/server.mjs >> /tmp/flue.log 2>&1 ) &",
    "",
    "# Keepalive so the sandbox does not sleep while Flue works (max 2h).",
    "( STARTED=$(date +%s); MAX=7200; while true; do sleep 30; NOW=$(date +%s); [ $((NOW - STARTED)) -ge $MAX ] && break; done ) &",
    "",
    "exit 0",
  ].join("\n")
}

async function ensureRepoCloned(sandbox: ReturnType<typeof getSandbox>, opts: SandboxSetupOpts): Promise<void> {
  if (!opts.repo) return

  const checkRepo = await sandbox.exec("test -d /workspace/repo/.git", { cwd: "/workspace" })
  if (!checkRepo.success) {
    // Clone target must not exist as a directory — `mv src dest` nests into
    // dest when dest already exists. Clear any stray /workspace/repo, keep
    // only the parent, then rename repo-tmp → repo atomically.
    await sandbox.exec("rm -rf /workspace/repo /workspace/repo-tmp && mkdir -p /workspace", { cwd: "/workspace" })
    const cloneUrl = opts.installationToken
      ? `https://x-access-token:${opts.installationToken}@github.com/${opts.repo}.git`
      : `https://github.com/${opts.repo}.git`
    // Clone into a temp dir then move, so a partial failure never leaves a
    // half-populated /workspace/repo that blocks the next attempt.
    const cloneResult = await sandbox.exec(
      `git clone --depth 50 ${cloneUrl} /workspace/repo-tmp && mv /workspace/repo-tmp /workspace/repo`,
      { cwd: "/workspace" },
    )
    if (!cloneResult.success) {
      await sandbox.exec("rm -rf /workspace/repo-tmp", { cwd: "/workspace" })
      throw new Error(`git clone failed: ${cloneResult.stderr}`)
    }
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
  const push = (key: string, value: string) => {
    envLines.push(`export ${key}=${shellQuote(value)}`)
  }

  if (opts.openrouterApiKey) push("OPENROUTER_API_KEY", opts.openrouterApiKey)
  if (opts.anthropicApiKey) push("ANTHROPIC_API_KEY", opts.anthropicApiKey)
  if (opts.openaiApiKey) push("OPENAI_API_KEY", opts.openaiApiKey)
  if (opts.sentryDsn) push("SENTRY_DSN", opts.sentryDsn)
  if (opts.sentryAuthToken) push("SENTRY_AUTH_TOKEN", opts.sentryAuthToken)

  // Always record the intended Lore URL, but do NOT force OPENAI/ANTHROPIC base
  // URLs here — maybeEnableLoreBaseUrls() adds those only after a health probe.
  // Never write the shared FLUE_INTERNAL_TOKEN into the sandbox — mint a
  // per-entity ingest token for the reporter instead.
  const loreUrl = opts.loreGatewayUrl ?? "http://127.0.0.1:3207"
  push("LORE_GATEWAY_URL", loreUrl)

  push("FLUE_LOG_LEVEL", "debug")

  // Phase 2 / external Lore: if the URL is not loopback, enable base URLs now
  // (standalone gateway is assumed reachable from the DO / container).
  if (opts.loreGatewayUrl && !/127\.0\.0\.1|localhost/.test(opts.loreGatewayUrl)) {
    push("OPENAI_BASE_URL", `${loreUrl.replace(/\/$/, "")}/v1`)
    push("ANTHROPIC_BASE_URL", loreUrl.replace(/\/$/, ""))
  }

  await sandbox.writeFile("/tmp/flue-env.sh", `${envLines.join("\n")}\n`)
}

/**
 * Copy Flue workspace skills into the cloned repo AFTER clone.
 * Source of truth is /root/.agents/skills (baked into the image outside the
 * clone target) and optionally /opt/flue for Phase 1 images.
 */
async function ensureWorkspaceSkills(sandbox: ReturnType<typeof getSandbox>): Promise<void> {
  await sandbox.exec(
    "mkdir -p /workspace/repo/.agents && " +
      "([ -d /root/.agents/skills ] && cp -R /root/.agents/skills /workspace/repo/.agents/ || true) && " +
      "([ -f /root/AGENTS.md ] && cp /root/AGENTS.md /workspace/repo/AGENTS.md || true) && " +
      "([ -d /opt/flue/.agents/skills ] && cp -R /opt/flue/.agents/skills /workspace/repo/.agents/ || true) && " +
      "([ -f /opt/flue/AGENTS.md ] && cp /opt/flue/AGENTS.md /workspace/repo/AGENTS.md || true)",
    { cwd: "/workspace" },
  )
}

async function ensureSessionReporterRunning(
  sandbox: ReturnType<typeof getSandbox>,
  opts: { entityKey: string; appUrl?: string; flueInternalToken?: string },
): Promise<void> {
  const check = await sandbox.exec("pgrep -f 'session-reporter.sh' > /dev/null 2>&1", { cwd: "/workspace" })
  if (check.success) return
  await startSessionReporter(sandbox, opts)
}

/**
 * Background reporter: polls Flue conversation history and POSTs to
 * POST /api/containers/sessions so the dashboard stays populated.
 *
 * Uses a short-lived, entity-scoped ingest token — never the shared
 * FLUE_INTERNAL_TOKEN — so a compromised sandbox cannot forge other entities'
 * session data or unlock /agents/jared.
 */
async function startSessionReporter(
  sandbox: ReturnType<typeof getSandbox>,
  opts: { entityKey: string; appUrl?: string; flueInternalToken?: string },
): Promise<void> {
  if (!opts.appUrl) return
  if (!opts.flueInternalToken) {
    // Without a signing secret we cannot authenticate ingest — skip reporter.
    return
  }

  const ingestUrl = `${opts.appUrl.replace(/\/$/, "")}/api/containers/sessions`
  const conversationId = toAgentInstanceId(opts.entityKey)
  const ingestToken = await mintSessionIngestToken(opts.flueInternalToken, opts.entityKey)

  const reporterScript = [
    "#!/bin/bash",
    "set -u",
    `FLUE="http://localhost:${FLUE_PORT}"`,
    `MOUNT="${FLUE_AGENT_MOUNT}"`,
    `CONV=${shellQuote(conversationId)}`,
    `ENTITY_KEY=${shellQuote(opts.entityKey)}`,
    `INGEST=${shellQuote(ingestUrl)}`,
    `INGEST_TOKEN=${shellQuote(ingestToken)}`,
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
    "      messages: {($sid): (",
    `        if $hist | type == "object" then`,
    "          ($hist.messages // $hist.records // $hist.items // [])",
    `        elif $hist | type == "array" then $hist`,
    "        else [] end",
    "      )},",
    `      settlements: (if $hist | type == "object" then ($hist.settlements // []) else [] end),`,
    `      flueHistory: (if $hist | type == "object" then $hist else {messages: $hist, settlements: []} end),`,
    "      logs: $logs,",
    "      flue: true",
    `    }' 2>/dev/null)`,
    '    if [ -n "$SESSION_DATA" ]; then',
    `      BODY=$(jq -nc --arg ek "$ENTITY_KEY" --arg sd "$SESSION_DATA" '{entityKey: $ek, sessionData: $sd}' 2>/dev/null)`,
    '      HDR=(-H "Content-Type: application/json")',
    `      [ -n "$INGEST_TOKEN" ] && HDR+=(-H "${FLUE_INTERNAL_HEADER}: $INGEST_TOKEN")`,
    `      [ -n "$BODY" ] && curl -sf --max-time 15 -X POST "\${HDR[@]}" -d "$BODY" "$INGEST" >/dev/null 2>&1 || true`,
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
 * Failures are written to /tmp/flue-dispatch.err so they are visible in debug.
 */
export async function dispatchPrompt(
  sandbox: ReturnType<typeof getSandbox>,
  containerKey: string,
  prompt: string,
  eventId: string,
): Promise<void> {
  const conversationId = toAgentInstanceId(containerKey)
  const promptPayload = JSON.stringify({ kind: "user", body: prompt })
  const promptFile = `/tmp/prompt-${eventId}.json`
  await sandbox.writeFile(promptFile, promptPayload)

  const errFile = `/tmp/flue-dispatch-${eventId}.err`
  const okFile = `/tmp/flue-dispatch-${eventId}.ok`

  const dispatchScript = [
    "#!/bin/bash",
    "set -u",
    `FLUE="http://localhost:${FLUE_PORT}"`,
    `MOUNT="${FLUE_AGENT_MOUNT}"`,
    `CONV=${shellQuote(conversationId)}`,
    `PROMPT_FILE="${promptFile}"`,
    `ERR_FILE="${errFile}"`,
    `OK_FILE="${okFile}"`,
    'rm -f "$ERR_FILE" "$OK_FILE"',
    "",
    "# Wait for Flue to be ready (up to 180s).",
    "READY=0",
    "for i in $(seq 1 180); do",
    '  if curl -sf --max-time 2 "$FLUE/api/ping" >/dev/null 2>&1 || curl -sf --max-time 2 "$FLUE/health" >/dev/null 2>&1; then',
    "    READY=1",
    "    break",
    "  fi",
    "  sleep 1",
    "done",
    "",
    'if [ "$READY" -ne 1 ]; then',
    '  echo "flue not ready after 180s" > "$ERR_FILE"',
    "  exit 1",
    "fi",
    "",
    'echo "$CONV" > /tmp/dispatch-session-id',
    "",
    "# Admit the prompt (202). Flue processes asynchronously.",
    'HTTP_CODE=$(curl -s -o /tmp/flue-dispatch-body.txt -w "%{http_code}" -X POST \\',
    '  -H "Content-Type: application/json" -d @"$PROMPT_FILE" "$FLUE$MOUNT/$CONV" || echo "000")',
    'if [ "$HTTP_CODE" != "202" ] && [ "$HTTP_CODE" != "200" ]; then',
    '  echo "admit failed http=$HTTP_CODE body=$(cat /tmp/flue-dispatch-body.txt 2>/dev/null)" > "$ERR_FILE"',
    "  exit 1",
    "fi",
    'echo "ok http=$HTTP_CODE" > "$OK_FILE"',
  ].join("\n")

  const scriptFile = `/tmp/dispatch-${eventId}.sh`
  await sandbox.writeFile(scriptFile, dispatchScript)
  await sandbox.startProcess(`bash ${scriptFile}`, { cwd: "/workspace" })
}

/**
 * Save an initial session record to D1 so the container appears immediately.
 * Uses the canonical Flue conversation id so later history syncs merge cleanly.
 */
export async function saveInitialSession(db: DrizzleD1Database<typeof dbSchema>, containerKey: string): Promise<void> {
  const sessionId = toAgentInstanceId(containerKey)
  const initialData = JSON.stringify({
    sessionStatus: { [sessionId]: { type: "busy" } },
    sessions: [{ id: sessionId, title: containerKey, agent: AGENT }],
    logs: "",
    messages: {},
    flue: true,
  })
  await saveSession(db, containerKey, initialData)
}

/** Re-export for callers that already import from dispatch. */
export { resolveFlueInternalToken }
