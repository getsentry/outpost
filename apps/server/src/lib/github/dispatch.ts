// Shared logic to dispatch a (stored or freshly-received) GitHub webhook event
// to the Flue agent. Used by both the webhook handler and the manual "resend"
// endpoint so the two paths can never drift.
//
// Phase 1: ensureSandboxReady starts Flue in-container; dispatchPrompt admits via curl.
// Phase 2: FLUE_NATIVE=1 → thin sandbox + dispatchToFlueAgent (DO HTTP/SDK).

import { getSandbox } from "@cloudflare/sandbox"
import { formatError, type Logger } from "@jared/utils"
import * as Sentry from "@sentry/cloudflare"
import { eq } from "drizzle-orm"
import type { DrizzleD1Database } from "drizzle-orm/d1"
import * as dbSchema from "@/db/schema"
import { startAgentGeneration } from "@/lib/agents/lifecycle"
import { dispatchPrompt, ensureSandboxReady, saveInitialSession } from "@/lib/containers/dispatch"
import { admittedStatus } from "@/lib/events/delivery-status"
import { dispatchToFlueAgent } from "@/lib/containers/flue-dispatch"
import { toAgentInstanceId } from "@/lib/containers/ids"
import { SANDBOX_OPTS } from "@/lib/containers/sandbox-opts"
import { createGitHubApp } from "@/lib/github/app"
import { listOpenDiscussionObligations } from "@/lib/github/discussion-store"
import { extractDiscussionPrNumber, formatDiscussionInbox } from "@/lib/github/discussions"
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
  const sandboxId = toAgentInstanceId(containerKey)

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
    await Promise.all([startAgentGeneration(db, sandboxId), saveInitialSession(db, containerKey)])
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

    let discussionInbox = ""
    try {
      const payload = JSON.parse(evt.payload) as Record<string, unknown>
      const prNumber = extractDiscussionPrNumber(evt.event, payload)
      if (evt.repo && prNumber !== null) {
        discussionInbox = formatDiscussionInbox(await listOpenDiscussionObligations(db, evt.repo, prNumber))
      }
    } catch (err) {
      // Discussion tracking must never prevent a normal webhook turn. The next
      // admitted event will retry the snapshot query.
      logger.warn(
        { entity_key: containerKey, event_id: eventId, reason: formatError(err) },
        "discussion inbox load failed",
      )
    }

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
      discussionInbox,
    })

    logger.info({ entity_key: containerKey, event_id: eventId }, "dispatch.prompt.start")

    await mark("d:prompt")
    let submissionId: string | undefined
    if (flueNative) {
      // Phase 2: admit into the Flue Durable Object (agent attaches the sandbox itself).
      const receipt = await dispatchToFlueAgent(env, { entityKey: containerKey, prompt, logger })
      submissionId = receipt.submissionId
    } else {
      // Phase 1: container-side Flue HTTP admit via background script.
      await dispatchPrompt(sandbox, containerKey, prompt, eventId)
    }

    logger.info({ entity_key: containerKey, event_id: eventId }, "dispatch.prompt.scheduled")

    const now = new Date()
    await db
      .update(dbSchema.webhookEvents)
      .set({ status: admittedStatus(submissionId), dispatchedAt: now })
      .where(eq(dbSchema.webhookEvents.id, eventId))

    logger.info({ entity_key: containerKey, event_id: eventId, submission_id: submissionId }, "event admitted to agent")
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
