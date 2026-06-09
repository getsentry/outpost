// GitHub App webhook handler.
//
// Receives webhook events from GitHub, verifies the HMAC signature,
// parses the payload, extracts entity information, stores the event
// in D1, and dispatches it to the OpenCode container.
//
// Event lifecycle:
//   1. Webhook arrives → stored in D1
//      - Entity found → status "pending"
//      - No entity    → status "skipped" (no container created)
//   2. Return 200 to GitHub immediately
//   3. In waitUntil(): dispatch to OpenCode container
//      - Wait for container health
//      - Find or create OpenCode session
//      - Send prompt via prompt_async
//      - Mark event as "dispatched"
//      - On failure → mark event as "failed"

import { getContainer } from "@cloudflare/containers"
import { formatError } from "@jared/utils"
import { verify } from "@octokit/webhooks-methods"
import * as Sentry from "@sentry/cloudflare"
import { eq } from "drizzle-orm"
import { Hono } from "hono"
import * as dbSchema from "@/db/schema"
import { createGitHubApp } from "@/lib/github/app"
import { TRIGGER_LABEL } from "@/lib/github/constants"
import { extractEntityKey, lookupString } from "@/lib/github/entity"
import { formatEventPrompt } from "@/lib/github/prompt"
import type { WebhookEvent } from "@/lib/github/types"
import type { BaseEnv } from "@/types"

const HEALTH_MAX_RETRIES = 30
const HEALTH_INITIAL_DELAY_MS = 500
const HEALTH_MAX_DELAY_MS = 5000

/**
 * Wait for the OpenCode server inside the container to be ready.
 * Retries GET /global/health with exponential backoff.
 */
async function waitForHealth(container: { fetch: (req: Request) => Promise<Response> }): Promise<boolean> {
  let delay = HEALTH_INITIAL_DELAY_MS
  for (let i = 0; i < HEALTH_MAX_RETRIES; i++) {
    try {
      const res = await container.fetch(new Request("http://container/global/health"))
      if (res.ok) return true
    } catch {
      // Container not ready yet
    }
    await new Promise((r) => setTimeout(r, delay))
    delay = Math.min(delay * 1.5, HEALTH_MAX_DELAY_MS)
  }
  return false
}

/**
 * Find the existing session or create a new one.
 * Each container has one entity, so there should be at most one session.
 */
async function findOrCreateSession(
  container: { fetch: (req: Request) => Promise<Response> },
  title: string,
): Promise<string | null> {
  // List existing sessions
  const listRes = await container.fetch(new Request("http://container/session"))
  if (listRes.ok) {
    const sessions = (await listRes.json()) as Array<{ id: string }>
    if (sessions.length > 0) {
      return sessions[0].id
    }
  }

  // No sessions — create one
  const createRes = await container.fetch(
    new Request("http://container/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    }),
  )
  if (createRes.ok) {
    const session = (await createRes.json()) as { id: string }
    return session.id
  }

  return null
}

const router = new Hono<BaseEnv>().post("/github-app", async (c) => {
  const logger = c.get("logger").child({ ns: "webhook" })
  const db = c.get("db")
  const webhookSecret = c.env.GITHUB_APP_WEBHOOK_SECRET
  if (!webhookSecret) {
    return c.json({ error: "GitHub App webhook secret not configured" }, 503)
  }

  // --- Validate required headers ---
  const event = c.req.header("x-github-event")
  const deliveryId = c.req.header("x-github-delivery")
  const signature = c.req.header("x-hub-signature-256")

  if (!event || !deliveryId) {
    return c.json(
      {
        error: "Missing required headers (x-github-event, x-github-delivery)",
      },
      400,
    )
  }

  if (!signature) {
    return c.json({ error: "Missing signature header" }, 401)
  }

  // --- Read and verify body ---
  const rawBody = await c.req.text()

  const isValid = await verify(webhookSecret, rawBody, signature)
  if (!isValid) {
    return c.json({ error: "Invalid signature" }, 401)
  }

  // --- Parse payload ---
  let payload: Record<string, unknown> = {}
  let action: string | null = null
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>
    if (typeof payload.action === "string") {
      action = payload.action
    }
  } catch {
    // Non-JSON payload — proceed with empty object
  }

  // --- Extract metadata from payload ---
  const installationId = (payload.installation as { id?: number } | undefined)?.id ?? null
  const sender = lookupString(payload, "sender.login")
  const repo = lookupString(payload, "repository.full_name")

  // --- Get installation Octokit for entity enrichment ---
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
    // Entity extraction is best-effort — log and continue
    logger.warn({ error: formatError(err) }, "entity extraction failed")
    Sentry.captureException(err)
  }

  try {
    botLogin = await app.getBotLogin()
  } catch (err) {
    logger.warn({ error: formatError(err) }, "bot login resolution failed")
  }

  // --- Build structured event ---
  const webhookEvent: WebhookEvent = {
    event,
    action,
    deliveryId,
    installationId,
    sender,
    repo,
    entityKey,
    payload,
  }

  // --- Log the event ---
  logger.info(
    {
      event: webhookEvent.event,
      action: webhookEvent.action,
      delivery_id: webhookEvent.deliveryId,
      sender: webhookEvent.sender,
      repo: webhookEvent.repo,
      entity_key: webhookEvent.entityKey?.key ?? null,
      installation_id: webhookEvent.installationId,
    },
    "webhook.received",
  )

  // --- Determine if this event is routable to a container ---
  // Skip issues.labeled events unless the label matches the trigger label,
  // to avoid spinning up containers for irrelevant label additions.
  // Also skip issues.assigned/unassigned — assignment is not used as a trigger
  // (GitHub App bots can't be assigned via the UI).
  const isSkipped =
    !entityKey ||
    (event === "issues" && action === "labeled" && lookupString(payload, "label.name") !== TRIGGER_LABEL) ||
    (event === "issues" && (action === "assigned" || action === "unassigned"))
  const containerKey = entityKey?.key ?? `ephemeral/${deliveryId}`
  const eventId = crypto.randomUUID()

  // --- Store event in D1 (dedup via delivery_id UNIQUE constraint) ---
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
    // If delivery_id already exists, this is a duplicate — return early
    if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
      logger.info({ delivery_id: deliveryId }, "duplicate delivery, skipping")
      return c.json({
        ok: true,
        delivery_id: deliveryId,
        duplicate: true,
      })
    }
    throw err
  }

  // --- If skipped (no entity or filtered out), we're done ---
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

  // --- Dispatch to container in the background ---
  // Return 200 to GitHub immediately, then handle container communication
  // asynchronously via waitUntil().

  /** Mark an event as failed in D1 so it doesn't stay stuck in "pending". */
  async function markEventFailed(reason: string) {
    try {
      await db.update(dbSchema.webhookEvents).set({ status: "failed" }).where(eq(dbSchema.webhookEvents.id, eventId))
    } catch (dbErr) {
      logger.error({ error: formatError(dbErr), event_id: eventId }, "failed to mark event as failed")
    }
    logger.error({ entity_key: containerKey, event_id: eventId, reason }, "dispatch failed")
  }

  c.executionCtx.waitUntil(
    (async () => {
      try {
        const container = getContainer(c.env.OPENCODE, containerKey)

        // Wait for OpenCode to be ready (handles cold start)
        const healthy = await waitForHealth(container)
        if (!healthy) {
          await markEventFailed("container health check timed out")
          return
        }

        // Find or create an OpenCode session
        const sessionId = await findOrCreateSession(container, containerKey)
        if (!sessionId) {
          await markEventFailed("failed to find or create session")
          return
        }

        // Format the event as a markdown prompt
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

        // Send the prompt asynchronously — OpenCode queues it if busy
        const promptRes = await container.fetch(
          new Request(`http://container/session/${sessionId}/prompt_async`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              parts: [{ type: "text", text: prompt }],
            }),
          }),
        )

        if (!promptRes.ok) {
          const body = await promptRes.text()
          await markEventFailed(`prompt_async returned ${promptRes.status}: ${body}`)
          return
        }

        // Mark the event as dispatched
        await db
          .update(dbSchema.webhookEvents)
          .set({ status: "dispatched", dispatchedAt: new Date() })
          .where(eq(dbSchema.webhookEvents.id, eventId))

        logger.info(
          {
            entity_key: containerKey,
            event_id: eventId,
            session_id: sessionId,
          },
          "event dispatched to agent",
        )
      } catch (err) {
        await markEventFailed(formatError(err))
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
