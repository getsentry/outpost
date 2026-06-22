// Shared logic to dispatch a (stored or freshly-received) GitHub webhook event
// to the OpenCode agent. Used by both the webhook handler and the manual
// "resend" endpoint so the two paths can never drift.

import { getSandbox } from "@cloudflare/sandbox"
import { formatError, type Logger } from "@jared/utils"
import * as Sentry from "@sentry/cloudflare"
import { eq } from "drizzle-orm"
import type { DrizzleD1Database } from "drizzle-orm/d1"
import * as dbSchema from "@/db/schema"
import { dispatchPrompt, ensureSandboxReady, saveInitialSession } from "@/lib/containers/dispatch"
import { createGitHubApp } from "@/lib/github/app"
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

/**
 * Mint a fresh installation token, ensure the sandbox is ready, format the event
 * prompt, and dispatch it to the agent — updating the event status as it goes.
 *
 * Intended to run inside c.executionCtx.waitUntil(): it never throws, recording
 * failures to the event row and Sentry instead.
 */
export async function dispatchGitHubEvent(env: Env, db: Db, logger: Logger, evt: GitHubEventDispatch): Promise<void> {
  const { eventId, containerKey } = evt

  const app = createGitHubApp({
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET,
  })

  // Mint an installation token (scoped to the repo's installation).
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

  // Save an initial session immediately so the container appears in the UI
  // before the (potentially slow) sandbox startup completes.
  try {
    await saveInitialSession(db, containerKey, `pending-${eventId.slice(0, 8)}`)
  } catch {
    /* best effort — may conflict with an existing row */
  }

  try {
    logger.info({ entity_key: containerKey, event_id: eventId }, "dispatch.start")

    const sandbox = getSandbox(env.Sandbox, containerKey, { normalizeId: true, sleepAfter: "2h" })

    logger.info({ entity_key: containerKey, event_id: eventId }, "dispatch.sandbox_ready.start")
    await ensureSandboxReady(sandbox, {
      repo: evt.repo,
      botLogin,
      installationToken,
      anthropicApiKey: env.ANTHROPIC_API_KEY,
      openaiApiKey: env.OPENAI_API_KEY,
      sentryDsn: env.SENTRY_DSN,
      entityKey: containerKey,
      appUrl: env.APP_URL,
    })
    logger.info({ entity_key: containerKey, event_id: eventId }, "dispatch.sandbox_ready.done")

    const prompt = formatEventPrompt({
      event: evt.event,
      action: evt.action,
      deliveryId: evt.deliveryId,
      sender: evt.sender,
      repo: evt.repo,
      entityKey: containerKey,
      payload: evt.payload,
      botLogin,
    })

    logger.info({ entity_key: containerKey, event_id: eventId }, "dispatch.prompt.start")
    // Schedules the prompt via a container-side script (does not block on
    // OpenCode startup). The agent processes it autonomously; the UI sync picks
    // up the real session and messages.
    await dispatchPrompt(sandbox, containerKey, prompt, eventId)
    logger.info({ entity_key: containerKey, event_id: eventId }, "dispatch.prompt.scheduled")

    await db
      .update(dbSchema.webhookEvents)
      .set({ status: "dispatched", dispatchedAt: new Date() })
      .where(eq(dbSchema.webhookEvents.id, eventId))

    logger.info({ entity_key: containerKey, event_id: eventId }, "event dispatched to agent")
  } catch (err) {
    logger.error({ entity_key: containerKey, event_id: eventId, reason: formatError(err) }, "dispatch failed")
    Sentry.captureException(err)
    try {
      await db.update(dbSchema.webhookEvents).set({ status: "failed" }).where(eq(dbSchema.webhookEvents.id, eventId))
    } catch {
      /* best effort */
    }
  }
}
