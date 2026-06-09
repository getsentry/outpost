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
  },
): Promise<void> {
  // Check if OpenCode is already running (fast path)
  try {
    const check = await sandbox.exec(`curl -sf http://localhost:${OPENCODE_PORT}/global/health`, { cwd: "/workspace" })
    if (check.success) return
  } catch {
    // Not running
  }

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

  if (envLines.length > 0) {
    await sandbox.writeFile("/tmp/opencode-env.sh", `${envLines.join("\n")}\n`)
  }

  // Start OpenCode
  const cwd = opts.repo ? "/workspace/repo" : "/workspace"
  const startCmd = `bash -c '[ -f /tmp/opencode-env.sh ] && . /tmp/opencode-env.sh; exec opencode serve --port ${OPENCODE_PORT} --hostname 0.0.0.0'`
  const proc = await sandbox.startProcess(startCmd, { cwd })
  await proc.waitForPort(OPENCODE_PORT)

  // Start a keepalive process to prevent sandbox inactivity timeout.
  // The agent works via LLM calls that the sandbox can't see as activity,
  // so we ping OpenCode every 45s to reset the inactivity timer.
  // The loop exits when:
  //   - OpenCode stops responding (process crashed/stopped)
  //   - Maximum runtime of 2 hours is reached (safety limit)
  await sandbox.startProcess(
    `bash -c 'STARTED=$(date +%s); MAX=7200; while true; do sleep 45; curl -sf http://localhost:${OPENCODE_PORT}/global/health > /dev/null 2>&1 || break; NOW=$(date +%s); [ $((NOW - STARTED)) -ge $MAX ] && break; done'`,
    { cwd: "/workspace" },
  )
}

/**
 * Dispatch a prompt to OpenCode inside the sandbox.
 */
async function dispatchPrompt(
  sandbox: ReturnType<typeof getSandbox>,
  containerKey: string,
  prompt: string,
  eventId: string,
): Promise<string> {
  const OC = `http://localhost:${OPENCODE_PORT}`

  // Find or create session
  const listResult = await sandbox.exec(`curl -sf ${OC}/session`, { cwd: "/workspace" })
  let sessionId: string | null = null

  if (listResult.success && listResult.stdout) {
    try {
      const sessions = JSON.parse(listResult.stdout) as Array<{ id: string }>
      if (sessions.length > 0) sessionId = sessions[0].id
    } catch {
      /* empty */
    }
  }

  if (!sessionId) {
    const body = JSON.stringify({ title: containerKey })
    const createResult = await sandbox.exec(
      `curl -sf -X POST -H 'Content-Type: application/json' -d '${body.replace(/'/g, "'\\''")}' ${OC}/session`,
      { cwd: "/workspace" },
    )
    if (createResult.success && createResult.stdout) {
      try {
        const session = JSON.parse(createResult.stdout) as { id: string }
        sessionId = session.id
      } catch {
        /* empty */
      }
    }
  }

  if (!sessionId) throw new Error("failed to find or create session")

  // Write prompt to file to avoid shell escaping issues
  // Specify agent: "jared" to use the jared agent definition
  const promptPayload = JSON.stringify({ agent: "jared", parts: [{ type: "text", text: prompt }] })
  const promptFile = `/tmp/prompt-${eventId}.json`
  await sandbox.writeFile(promptFile, promptPayload)

  const promptResult = await sandbox.exec(
    `curl -sf -X POST -H 'Content-Type: application/json' -d @${promptFile} ${OC}/session/${sessionId}/prompt_async`,
    { cwd: "/workspace" },
  )
  await sandbox.exec(`rm -f ${promptFile}`, { cwd: "/workspace" })

  if (!promptResult.success) throw new Error(`prompt_async failed: ${promptResult.stderr}`)
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
        const sandbox = getSandbox(envBindings.Sandbox, containerKey, { normalizeId: true })

        await ensureSandboxReady(sandbox, {
          repo,
          botLogin,
          installationToken,
          anthropicApiKey: envBindings.ANTHROPIC_API_KEY,
          openaiApiKey: envBindings.OPENAI_API_KEY,
          sentryDsn: envBindings.SENTRY_DSN,
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
