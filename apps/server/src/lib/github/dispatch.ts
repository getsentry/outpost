// Shared logic to dispatch a (stored or freshly-received) GitHub webhook event
// to the Flue agent. Used by both the webhook handler and the manual "resend"
// endpoint so the two paths can never drift.
//
// Phase 1: ensureSandboxReady starts Flue in-container; dispatchPrompt admits via curl.
// Phase 2: FLUE_NATIVE=1 → thin sandbox + dispatchToFlueAgent (DO HTTP/SDK).

import { getSandbox } from "@cloudflare/sandbox"
import { formatError, type Logger } from "@jared/utils"
import * as Sentry from "@sentry/cloudflare"
import { and, eq, lte } from "drizzle-orm"
import type { DrizzleD1Database } from "drizzle-orm/d1"
import * as dbSchema from "@/db/schema"
import { dispatchPrompt, ensureSandboxReady, saveInitialSession } from "@/lib/containers/dispatch"
import { dispatchToFlueAgent } from "@/lib/containers/flue-dispatch"
import { toAgentInstanceId } from "@/lib/containers/ids"
import { SANDBOX_OPTS } from "@/lib/containers/sandbox-opts"
import { createGitHubApp } from "@/lib/github/app"
import { classifyModelTier } from "@/lib/github/model-tier"
import { formatEventPrompt } from "@/lib/github/prompt"
import type { BaseEnvBindings } from "@/types/env/base"

type Env = BaseEnvBindings["Bindings"]
type Db = DrizzleD1Database<typeof dbSchema>

export type GitHubEventDispatch = {
  /** The webhook_events row id (used to update status). */
  eventId: string
  containerKey: string
  event: string
  action: string | null
  deliveryId: string
  sender: string | null
  repo: string | null
  installationId: number | null
  /** Raw webhook payload JSON, embedded into the agent prompt. */
  payload: string
}

function isFlueNative(env: Env): boolean {
  return env.FLUE_NATIVE === "1" || env.FLUE_NATIVE === "true"
}

/**
 * Mint a fresh installation token, ensure the sandbox is ready, format the event
 * prompt, and dispatch it to the agent — updating the event status as it goes.
 *
 * Intended to run inside c.executionCtx.waitUntil(): it never throws, recording
 * failures to the event row and Sentry instead.
 */
export async function dispatchGitHubEvent(env: Env, db: Db, logger: Logger, evt: GitHubEventDispatch): Promise<void> {
  const { eventId, containerKey } = evt
  const flueNative = isFlueNative(env)

  const app = createGitHubApp({
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET,
  })

  let installationToken = ""
  if (evt.installationId) {
    try {
      const octokit = app.getInstallationOctokit(evt.installationId)
      const auth = (await octokit.auth({ type: "installation" })) as { token: string }
      installationToken = auth.token
    } catch (err) {
      logger.warn({ error: formatError(err) }, "failed to mint installation token")
    }
  }

  let botLogin = ""
  try {
    botLogin = await app.getBotLogin()
  } catch (err) {
    logger.warn({ error: formatError(err) }, "bot login resolution failed")
  }

  try {
    await saveInitialSession(db, containerKey)
  } catch {
    /* best effort — may conflict with an existing row */
  }

  // Diagnostic progress markers persisted to D1 so we can see how far the
  // background dispatch gets before any Worker eviction (Cloudflare kills the
  // waitUntil task without running our catch). Read back from webhook_events.status.
  const mark = async (status: string): Promise<void> => {
    try {
      await db.update(dbSchema.webhookEvents).set({ status }).where(eq(dbSchema.webhookEvents.id, eventId))
    } catch {
      /* best effort */
    }
  }

  try {
    logger.info({ entity_key: containerKey, event_id: eventId, flue_native: flueNative }, "dispatch.start")

    const sandboxId = toAgentInstanceId(containerKey)
    const sandbox = getSandbox(env.Sandbox, sandboxId, SANDBOX_OPTS)

    await mark("d:boot")
    logger.info({ entity_key: containerKey, event_id: eventId, sandbox_id: sandboxId }, "dispatch.sandbox_ready.start")
    const { resolveFlueInternalToken } = await import("@/middlewares/flue-auth")
    await ensureSandboxReady(sandbox, {
      repo: evt.repo,
      botLogin,
      installationToken,
      openrouterApiKey: env.OPENROUTER_API_KEY,
      anthropicApiKey: env.ANTHROPIC_API_KEY,
      openaiApiKey: env.OPENAI_API_KEY,
      sentryDsn: env.SENTRY_DSN,
      sentryAuthToken: env.SENTRY_AUTH_TOKEN,
      entityKey: containerKey,
      appUrl: env.APP_URL,
      thinSandbox: flueNative,
      loreGatewayUrl: env.LORE_GATEWAY_URL,
      flueInternalToken: (await resolveFlueInternalToken(env)) ?? undefined,
    })
    await mark("d:setup_done")
    logger.info({ entity_key: containerKey, event_id: eventId, sandbox_id: sandboxId }, "dispatch.sandbox_ready.done")

    const prompt = formatEventPrompt({
      event: evt.event,
      action: evt.action,
      deliveryId: evt.deliveryId,
      sender: evt.sender,
      repo: evt.repo,
      entityKey: containerKey,
      payload: evt.payload,
      botLogin,
      modelTier: classifyModelTier(evt.event, evt.action, evt.payload),
    })

    logger.info({ entity_key: containerKey, event_id: eventId }, "dispatch.prompt.start")

    await mark("d:prompt")
    if (flueNative) {
      // Phase 2: admit into the Flue Durable Object (agent attaches the sandbox itself).
      await dispatchToFlueAgent(env, { entityKey: containerKey, prompt, logger })
    } else {
      // Phase 1: container-side Flue HTTP admit via background script.
      await dispatchPrompt(sandbox, containerKey, prompt, eventId)
    }

    logger.info({ entity_key: containerKey, event_id: eventId }, "dispatch.prompt.scheduled")

    const now = new Date()
    await db
      .update(dbSchema.webhookEvents)
      .set({ status: "dispatched", dispatchedAt: now })
      .where(eq(dbSchema.webhookEvents.id, eventId))

    logger.info({ entity_key: containerKey, event_id: eventId }, "event dispatched to agent")
  } catch (err) {
    logger.error({ entity_key: containerKey, event_id: eventId, reason: formatError(err) }, "dispatch failed")
    Sentry.captureException(err)
    try {
      // Persist a short error snippet into status so failures are visible in D1
      // even if Sentry capture is not wired for this Worker.
      const snippet = formatError(err).slice(0, 180).replace(/\s+/g, " ")
      await db
        .update(dbSchema.webhookEvents)
        .set({ status: `failed:${snippet}`, completedAt: new Date() })
        .where(eq(dbSchema.webhookEvents.id, eventId))
    } catch {
      /* best effort */
    }
  }
}

/**
 * When a conversation goes idle after work, upgrade still-open `dispatched`
 * webhook rows for that entity to `completed` so the Events UI reflects finish.
 *
 * Pass `dispatchedBefore` (wall clock when idle was observed) so a webhook that
 * lands between observation and this update is not falsely completed.
 */
export async function markEntityEventsCompleted(
  db: Db,
  entityKey: string,
  opts?: { dispatchedBefore?: Date },
): Promise<void> {
  try {
    const conditions = [
      eq(dbSchema.webhookEvents.entityKey, entityKey),
      eq(dbSchema.webhookEvents.status, "dispatched"),
    ]
    if (opts?.dispatchedBefore) {
      conditions.push(lte(dbSchema.webhookEvents.dispatchedAt, opts.dispatchedBefore))
    }
    await db
      .update(dbSchema.webhookEvents)
      .set({ status: "completed", completedAt: new Date() })
      .where(and(...conditions))
  } catch {
    /* best effort */
  }
}
