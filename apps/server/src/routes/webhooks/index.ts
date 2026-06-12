// GitHub App webhook handler.
//
// Receives webhook events from GitHub, verifies the HMAC signature,
// parses the payload, extracts entity information, stores the event
// in D1, and dispatches it to the OpenCode sandbox.
//
// Event lifecycle:
//   1. Webhook arrives → check if the entity has the "jared" label
//      - Has label → stored in D1 as "pending", dispatched to sandbox
//      - No label  → stored in D1 as "skipped"
//   2. Return 200 to GitHub immediately
//   3. In waitUntil: attempt dispatch to sandbox
//      - Warm sandbox (OpenCode running): dispatch in <2s
//      - Cold sandbox: start setup, mark event as "pending" (next event will succeed)

import { getSandbox } from "@cloudflare/sandbox"
import { formatError } from "@jared/utils"
import { verify } from "@octokit/webhooks-methods"
import * as Sentry from "@sentry/cloudflare"
import { eq } from "drizzle-orm"
import { Hono } from "hono"
import * as dbSchema from "@/db/schema"
import { saveSession } from "@/lib/containers/sessions"
import { createGitHubApp } from "@/lib/github/app"
import { TRIGGER_LABEL } from "@/lib/github/constants"
import { extractEntityKey, lookup, lookupString } from "@/lib/github/entity"
import { formatEventPrompt } from "@/lib/github/prompt"
import type { BaseEnv } from "@/types"

const OPENCODE_PORT = 4096

/**
 * Set up the sandbox: clone repo, configure git, start OpenCode.
 * Idempotent — safe to call on every event.
 */
async function ensureSandboxReady(
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
  // Must verify both the process exists AND responds to health checks,
  // since deploys can kill processes while leaving the container alive.
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
  // Enable debug logging so we can see what OpenCode/agent is doing
  envLines.push('export OPENCODE_LOG_LEVEL="debug"')

  await sandbox.writeFile("/tmp/opencode-env.sh", `${envLines.join("\n")}\n`)

  // Start OpenCode with logs redirected to a file for debugging
  const cwd = opts.repo ? "/workspace/repo" : "/workspace"
  const startCmd = `bash -c '[ -f /tmp/opencode-env.sh ] && . /tmp/opencode-env.sh; opencode serve --port ${OPENCODE_PORT} --hostname 0.0.0.0 >> /tmp/opencode.log 2>&1'`
  const proc = await sandbox.startProcess(startCmd, { cwd })
  await proc.waitForPort(OPENCODE_PORT)

  // Start a keepalive bash script that periodically collects session data
  // from OpenCode and POSTs it to the Worker for D1 persistence.
  const keepaliveScript = [
    "#!/bin/bash",
    `PORT=${OPENCODE_PORT}`,
    `ENTITY_KEY='${opts.entityKey.replace(/'/g, "'\\''")}'`,
    "STARTED=$(date +%s)",
    "MAX=7200",
    "",
    "sleep 10",
    "",
    "while true; do",
    "  curl -sf http://localhost:$PORT/global/health > /dev/null 2>&1 || break",
    "",
    "  curl -sf http://localhost:$PORT/session/status > /tmp/ka_status.json 2>/dev/null || echo '{}' > /tmp/ka_status.json",
    "  curl -sf http://localhost:$PORT/session > /tmp/ka_sessions.json 2>/dev/null || echo '[]' > /tmp/ka_sessions.json",
    "  tail -100 /tmp/opencode.log > /tmp/ka_logs.txt 2>/dev/null || echo '' > /tmp/ka_logs.txt",
    "",
    "  echo '{}' > /tmp/ka_messages.json",
    "  for SID in $(jq -r '.[].id' /tmp/ka_sessions.json 2>/dev/null); do",
    '    curl -sf "http://localhost:$PORT/session/$SID/message?limit=50" > /tmp/ka_msg_$SID.json 2>/dev/null',
    "    if [ -s /tmp/ka_msg_$SID.json ]; then",
    "      jq --arg sid \"$SID\" --slurpfile msgs /tmp/ka_msg_$SID.json '. + {($sid): $msgs[0]}' /tmp/ka_messages.json > /tmp/ka_messages_new.json 2>/dev/null && mv /tmp/ka_messages_new.json /tmp/ka_messages.json",
    "    fi",
    "    rm -f /tmp/ka_msg_$SID.json",
    "  done",
    "",
    "  jq -n \\",
    '    --arg ek "$ENTITY_KEY" \\',
    "    --slurpfile ss /tmp/ka_status.json \\",
    "    --slurpfile se /tmp/ka_sessions.json \\",
    "    --rawfile lo /tmp/ka_logs.txt \\",
    "    --slurpfile ms /tmp/ka_messages.json \\",
    "    '{entityKey: $ek, sessionData: ({sessionStatus: $ss[0], sessions: $se[0], logs: $lo, messages: $ms[0]} | tostring)}' \\",
    "    > /tmp/ka_payload.json 2>/dev/null",
    "",
    "  if [ -s /tmp/ka_payload.json ]; then",
    '    curl -sf -X POST "http://jared.internal/sessions/save" \\',
    "      -H 'Content-Type: application/json' \\",
    "      -d @/tmp/ka_payload.json > /dev/null 2>&1",
    "  fi",
    "",
    "  rm -f /tmp/ka_*.json /tmp/ka_*.txt",
    "",
    "  NOW=$(date +%s)",
    "  ELAPSED=$((NOW - STARTED))",
    "  [ $ELAPSED -ge $MAX ] && break",
    "",
    "  sleep 45",
    "done",
  ].join("\n")
  await sandbox.writeFile("/tmp/keepalive.sh", keepaliveScript)
  await sandbox.startProcess("bash /tmp/keepalive.sh", { cwd: "/workspace" })
}

/**
 * Dispatch a prompt to OpenCode inside the sandbox.
 * Uses curl with fallback for both v1.17.0 and v1.17.4+ API formats.
 */
async function dispatchPrompt(
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
    // Try both old and new create endpoints
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
  const promptPayload = JSON.stringify({ agent: "jared", parts: [{ type: "text", text: prompt }] })
  const promptFile = `/tmp/prompt-${eventId}.json`
  await sandbox.writeFile(promptFile, promptPayload)

  // Try prompt_async (v1.17.0), then /api/session/:id/prompt (v1.17.4+)
  const promptResult = await sandbox.exec(
    `curl -sf -X POST -H 'Content-Type: application/json' -d @${promptFile} ${OC}/session/${sessionId}/prompt_async 2>/dev/null || curl -sf -X POST -H 'Content-Type: application/json' -d @${promptFile} ${OC}/api/session/${sessionId}/prompt 2>/dev/null`,
    { cwd: "/workspace" },
  )
  await sandbox.exec(`rm -f ${promptFile}`, { cwd: "/workspace" })

  if (!promptResult.success) throw new Error(`prompt dispatch failed: ${promptResult.stderr}`)
  return sessionId
}

const router = new Hono<BaseEnv>().post("/github-app", async (c) => {
  const logger = c.get("logger").child({ ns: "webhook" })
  const db = c.get("db")
  const webhookSecret = c.env.GITHUB_APP_WEBHOOK_SECRET
  if (!webhookSecret) {
    return c.json({ error: "GitHub App webhook secret not configured" }, 503)
  }

  const event = c.req.header("x-github-event")
  const deliveryId = c.req.header("x-github-delivery")
  const signature = c.req.header("x-hub-signature-256")

  if (!event || !deliveryId) {
    return c.json({ error: "Missing required headers (x-github-event, x-github-delivery)" }, 400)
  }
  if (!signature) {
    return c.json({ error: "Missing signature header" }, 401)
  }

  const rawBody = await c.req.text()
  const isValid = await verify(webhookSecret, rawBody, signature)
  if (!isValid) {
    return c.json({ error: "Invalid signature" }, 401)
  }

  let payload: Record<string, unknown> = {}
  let action: string | null = null
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>
    if (typeof payload.action === "string") action = payload.action
  } catch {
    /* empty */
  }

  const installationId = (payload.installation as { id?: number } | undefined)?.id ?? null
  const sender = lookupString(payload, "sender.login")
  const repo = lookupString(payload, "repository.full_name")

  let entityKey = null
  let botLogin = ""
  const app = createGitHubApp({
    appId: c.env.GITHUB_APP_ID,
    privateKey: c.env.GITHUB_APP_PRIVATE_KEY,
    webhookSecret,
  })

  try {
    const octokit = installationId ? app.getInstallationOctokit(installationId) : null
    entityKey = await extractEntityKey(event, payload, octokit)
  } catch (err) {
    logger.warn({ error: formatError(err) }, "entity extraction failed")
    Sentry.captureException(err)
  }

  try {
    botLogin = await app.getBotLogin()
  } catch (err) {
    logger.warn({ error: formatError(err) }, "bot login resolution failed")
  }

  logger.info(
    {
      event,
      action,
      delivery_id: deliveryId,
      sender,
      repo,
      entity_key: entityKey?.key ?? null,
      installation_id: installationId,
    },
    "webhook.received",
  )

  // Only dispatch events where:
  // 1. The related issue/PR has the trigger label, OR
  // 2. The issue/PR was created by the bot (follow-up events on bot's own work)
  let hasLabel = false
  let isBotEntity = false
  if (entityKey) {
    // Check if the bot authored the entity (PR or issue)
    if (botLogin) {
      const prAuthor = lookupString(payload, "pull_request.user.login")
      const issueAuthor = lookupString(payload, "issue.user.login")
      isBotEntity = prAuthor === botLogin || issueAuthor === botLogin

      // check_suite/workflow_run: these payloads don't have pull_request.user.
      // Check multiple signals: sender, head_commit author, and the commit author.
      if (!isBotEntity && (event === "check_suite" || event === "workflow_run")) {
        const ciObj = lookup(payload, event) as Record<string, unknown> | null
        const headCommitAuthor = lookupString(ciObj ?? {}, "head_commit.author.name")
        const commitAuthor = lookupString(ciObj ?? {}, "head_commit.committer.name")
        isBotEntity = sender === botLogin || headCommitAuthor === botLogin || commitAuthor === botLogin
      }
    }

    // issues.labeled — check the label being added
    if (event === "issues" && action === "labeled") {
      hasLabel = lookupString(payload, "label.name") === TRIGGER_LABEL
    }
    // issues.* / issue_comment.* — check payload.issue.labels
    else if (event === "issues" || event === "issue_comment") {
      const labels = lookup(payload, "issue.labels") as Array<{ name?: string }> | undefined
      hasLabel = Array.isArray(labels) && labels.some((l) => l.name === TRIGGER_LABEL)
    }
    // pull_request.* / pull_request_review.* / pull_request_review_comment.* — check payload.pull_request.labels
    else if (event.startsWith("pull_request")) {
      const labels = lookup(payload, "pull_request.labels") as Array<{ name?: string }> | undefined
      hasLabel = Array.isArray(labels) && labels.some((l) => l.name === TRIGGER_LABEL)
    }
    // check_suite / workflow_run — no labels in payload, but dispatch if bot-authored
    // (CI events on default branch are already filtered in extractEntityKey)
  }
  const isSkipped = !(hasLabel || isBotEntity)

  const containerKey = entityKey?.key ?? `ephemeral/${deliveryId}`
  const eventId = crypto.randomUUID()

  try {
    await db.insert(dbSchema.webhookEvents).values({
      id: eventId,
      entityKey: containerKey,
      event,
      action,
      deliveryId,
      sender,
      repo,
      installationId,
      payload: rawBody,
      status: isSkipped ? "skipped" : "pending",
      createdAt: new Date(),
    })
  } catch (err) {
    if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
      return c.json({ ok: true, delivery_id: deliveryId, duplicate: true })
    }
    throw err
  }

  if (isSkipped) {
    logger.info({ delivery_id: deliveryId, event, action }, "event skipped")
    return c.json({
      ok: true,
      delivery_id: deliveryId,
      event,
      action,
      duplicate: false,
      entity_key: entityKey?.key ?? null,
      installation_id: installationId,
      skipped: true,
    })
  }

  // --- Dispatch to sandbox in waitUntil ---
  // Mint installation token before entering waitUntil
  let installationToken = ""
  if (installationId) {
    try {
      const octokit = app.getInstallationOctokit(installationId)
      const auth = (await octokit.auth({ type: "installation" })) as { token: string }
      installationToken = auth.token
    } catch (err) {
      logger.warn({ error: formatError(err) }, "failed to mint installation token")
    }
  }

  const envBindings = c.env

  c.executionCtx.waitUntil(
    (async () => {
      try {
        const sandbox = getSandbox(envBindings.Sandbox, containerKey, {
          normalizeId: true,
          // Agent runs take 15-30 min but all SDK-level activity (exec, writeFile, etc.)
          // happens in the first ~30s during setup. After that, the agent works via LLM
          // calls inside the container which are invisible to the SDK. The default 10m
          // sleepAfter was killing containers mid-work. Set to 2h to give agents plenty
          // of uninterrupted runtime.
          sleepAfter: "2h",
        })

        await ensureSandboxReady(sandbox, {
          repo,
          botLogin,
          installationToken,
          anthropicApiKey: envBindings.ANTHROPIC_API_KEY,
          openaiApiKey: envBindings.OPENAI_API_KEY,
          sentryDsn: envBindings.SENTRY_DSN,
          entityKey: containerKey,
        })

        const prompt = formatEventPrompt({
          event,
          action,
          deliveryId,
          sender,
          repo,
          entityKey: containerKey,
          payload: rawBody,
          botLogin,
        })

        const sessionId = await dispatchPrompt(sandbox, containerKey, prompt, eventId)

        // Save an initial session record to D1 immediately so the container
        // appears in the agent sessions list right away — don't wait for the
        // keepalive script's first 45s cycle.
        try {
          const initialData = JSON.stringify({
            sessionStatus: { [sessionId]: { type: "busy" } },
            sessions: [{ id: sessionId, title: containerKey }],
            logs: "",
            messages: {},
          })
          await saveSession(db, containerKey, initialData)
        } catch {
          /* best effort — keepalive will overwrite with real data soon */
        }

        await db
          .update(dbSchema.webhookEvents)
          .set({ status: "dispatched", dispatchedAt: new Date() })
          .where(eq(dbSchema.webhookEvents.id, eventId))

        logger.info({ entity_key: containerKey, event_id: eventId, session_id: sessionId }, "event dispatched to agent")
      } catch (err) {
        try {
          await db
            .update(dbSchema.webhookEvents)
            .set({ status: "failed" })
            .where(eq(dbSchema.webhookEvents.id, eventId))
        } catch {
          /* best effort */
        }
        logger.error({ entity_key: containerKey, event_id: eventId, reason: formatError(err) }, "dispatch failed")
        Sentry.captureException(err)
      }
    })(),
  )

  return c.json({
    ok: true,
    delivery_id: deliveryId,
    event,
    action,
    duplicate: false,
    entity_key: entityKey?.key ?? null,
    installation_id: installationId,
    skipped: false,
  })
})

export default router
