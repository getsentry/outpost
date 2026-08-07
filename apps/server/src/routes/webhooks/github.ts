// GitHub App webhook handler.
//
// Receives webhook events from GitHub, verifies the HMAC signature,
// parses the payload, extracts entity information, stores the event
// in D1, and dispatches it to the Flue agent (Durable Object or in-container).

import { formatError } from "@jared/utils"
import { verify } from "@octokit/webhooks-methods"
import * as Sentry from "@sentry/cloudflare"
import { and, eq, gt, inArray } from "drizzle-orm"
import { Hono } from "hono"
import * as dbSchema from "@/db/schema"
import { classifyCiEvent, isCiEvent } from "@/lib/github/actionability"
import { createGitHubApp } from "@/lib/github/app"
import { TRIGGER_LABEL } from "@/lib/github/constants"
import { dispatchGitHubEvent } from "@/lib/github/dispatch"
import { extractEntityKey, lookup, lookupString } from "@/lib/github/entity"
import type { BaseEnv } from "@/types"

// A CI burst (many workflow_run/check_suite completions for one push) lands
// within seconds. If an actionable CI event for the same entity is still
// unprocessed, fold later ones into it: the agent re-derives live CI status via
// `gh` when it handles that event, so the burst collapses to a single re-check.
const CI_COALESCE_WINDOW_MS = 10 * 60 * 1000

const router = new Hono<BaseEnv>().post("/", async (c) => {
  const logger = c.get("logger").child({ ns: "webhook.github" })
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
    if (botLogin) {
      const prAuthor = lookupString(payload, "pull_request.user.login")
      const issueAuthor = lookupString(payload, "issue.user.login")
      isBotEntity = prAuthor === botLogin || issueAuthor === botLogin

      if (!isBotEntity && (event === "check_suite" || event === "workflow_run")) {
        const ciObj = lookup(payload, event) as Record<string, unknown> | null
        const headCommitAuthor = lookupString(ciObj ?? {}, "head_commit.author.name")
        const commitAuthor = lookupString(ciObj ?? {}, "head_commit.committer.name")
        isBotEntity = sender === botLogin || headCommitAuthor === botLogin || commitAuthor === botLogin
      }
    }

    if (event === "issues" && action === "labeled") {
      hasLabel = lookupString(payload, "label.name") === TRIGGER_LABEL
    } else if (event === "issues" || event === "issue_comment") {
      const labels = lookup(payload, "issue.labels") as Array<{ name?: string }> | undefined
      hasLabel = Array.isArray(labels) && labels.some((l) => l.name === TRIGGER_LABEL)
    } else if (event.startsWith("pull_request")) {
      const labels = lookup(payload, "pull_request.labels") as Array<{ name?: string }> | undefined
      hasLabel = Array.isArray(labels) && labels.some((l) => l.name === TRIGGER_LABEL)
    }
  }
  // Self-triggered events (the bot reacting to its own comments/reviews/pushes)
  // are never actionable — the in-container router (jared.md skip condition #1)
  // already discards them. Skip here too so we don't wake a container just to
  // have it skip. Exception: CI events on the bot's own commits ARE actionable
  // (fix-ci / mark-pr-ready), matching that same router exception.
  const isSelfTriggered = !!botLogin && sender === botLogin && event !== "check_suite" && event !== "workflow_run"

  let skipReason: string | null = isSelfTriggered
    ? "self_triggered"
    : !entityKey
      ? "no_entity"
      : !(hasLabel || isBotEntity)
        ? "no_label"
        : null

  const containerKey = entityKey?.key ?? `ephemeral/${deliveryId}`

  // Second gate: drop noisy CI lifecycle events (requested/in_progress, and
  // cancelled/skipped/neutral completions) that Jared would only skip anyway,
  // and coalesce bursts of actionable CI completions for the same entity.
  if (!skipReason && isCiEvent(event)) {
    const verdict = classifyCiEvent(event, action, payload)
    if (!verdict.actionable) {
      skipReason = verdict.reason
    } else {
      const since = new Date(Date.now() - CI_COALESCE_WINDOW_MS)
      const pending = await db
        .select({ id: dbSchema.webhookEvents.id })
        .from(dbSchema.webhookEvents)
        .where(
          and(
            eq(dbSchema.webhookEvents.entityKey, containerKey),
            inArray(dbSchema.webhookEvents.event, ["check_suite", "workflow_run"]),
            inArray(dbSchema.webhookEvents.status, ["pending", "dispatched"]),
            gt(dbSchema.webhookEvents.createdAt, since),
          ),
        )
        .limit(1)
      if (pending.length > 0) skipReason = "ci_coalesced"
    }
  }

  const isSkipped = skipReason !== null

  const eventId = crypto.randomUUID()

  // Skipped events keep a tiny reason stub instead of the full GitHub JSON —
  // they dominate D1 size (~94% of rows) and are never resent.
  const storedPayload = isSkipped ? JSON.stringify({ reason: skipReason }) : rawBody

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
      payload: storedPayload,
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
    logger.info({ delivery_id: deliveryId, event, action, reason: skipReason }, "event skipped")
    return c.json({
      ok: true,
      delivery_id: deliveryId,
      event,
      action,
      duplicate: false,
      entity_key: entityKey?.key ?? null,
      installation_id: installationId,
      skipped: true,
      reason: skipReason,
    })
  }

  // --- Dispatch to sandbox in waitUntil (shared with the manual resend path) ---
  c.executionCtx.waitUntil(
    dispatchGitHubEvent(c.env, db, logger, {
      eventId,
      containerKey,
      event,
      action,
      deliveryId,
      sender,
      repo,
      installationId,
      payload: rawBody,
    }),
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
