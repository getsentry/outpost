/**
 * Authored Worker composition for Flue.
 *
 * Named exports become top-level Worker exports (alongside Flue-generated
 * agent DO classes). The default export contributes non-HTTP handlers only —
 * do NOT export fetch here (that lives in app.ts).
 *
 * The application-wide cron only performs D1 housekeeping. Agent follow-ups
 * remain per-conversation via Jared's scheduleFollowUp().
 */

import { retryOpenDiscussionObligations } from "./lib/events/discussion-retry.ts"
import { reconcileStuckDispatched } from "./lib/events/reconcile.ts"
import { deleteExpiredWebhookEvents } from "./lib/events/retention.ts"
import type { BaseEnvBindings } from "./types/env/base.ts"

// ContainerProxy is a WorkerEntrypoint the Sandbox DO reaches via
// `ctx.exports.ContainerProxy` to build outbound-interception fetchers (see
// JaredSandbox.outboundByHost). It MUST be a top-level Worker export or the
// container fails to start with "ctx.exports.ContainerProxy is undefined".
export { ContainerProxy } from "@cloudflare/sandbox"
export { Sandbox } from "./lib/containers/sandbox.ts"

export default {
  async scheduled(
    controller: ScheduledController,
    env: BaseEnvBindings["Bindings"],
    _ctx: ExecutionContext,
  ): Promise<void> {
    let discussionRetries = { retried: 0, needsHuman: 0 }
    try {
      discussionRetries = await retryOpenDiscussionObligations(env, controller.scheduledTime)
    } catch (err) {
      console.warn("github_discussion_obligations.retry.failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    }

    const deleted = await deleteExpiredWebhookEvents(env.DB, controller.scheduledTime)

    // Intermediate `d:%` sub-statuses (>30m) never reached the agent — a genuine
    // pre-dispatch stall, so time them out outright.
    const stuckCutoff = Math.floor((controller.scheduledTime - 30 * 60 * 1000) / 1000)
    const stuck = await env.DB.prepare(
      "UPDATE webhook_events SET status = 'failed:timeout', completed_at = ? WHERE status LIKE 'd:%' AND created_at < ?",
    )
      .bind(Math.floor(controller.scheduledTime / 1000), stuckCutoff)
      .run()

    // Long-lived `dispatched` rows (>2h) WERE admitted to the agent; reconcile
    // them against the live Flue DO (idle → completed) instead of blanket-timing
    // out finished work. Falls back to the old blanket timeout if the live read
    // path is unavailable, so events can never get wedged in `dispatched`.
    let reconciled = { entities: 0, completed: 0, timedOut: 0 }
    try {
      reconciled = await reconcileStuckDispatched(env, controller.scheduledTime)
    } catch (err) {
      console.warn("webhook_events.reconcile.failed", { error: err instanceof Error ? err.message : String(err) })
      const dispatchedCutoff = Math.floor((controller.scheduledTime - 2 * 60 * 60 * 1000) / 1000)
      const fallback = await env.DB.prepare(
        "UPDATE webhook_events SET status = 'failed:timeout', completed_at = ? WHERE status = 'dispatched' AND dispatched_at < ?",
      )
        .bind(Math.floor(controller.scheduledTime / 1000), dispatchedCutoff)
        .run()
      reconciled.timedOut = fallback.meta.changes ?? 0
    }

    console.info("webhook_events.retention.completed", {
      cron: controller.cron,
      deleted,
      timedOut: (stuck.meta.changes ?? 0) + reconciled.timedOut,
      reconciledCompleted: reconciled.completed,
      reconciledEntities: reconciled.entities,
      discussionRetries: discussionRetries.retried,
      discussionNeedsHuman: discussionRetries.needsHuman,
      actionableRetentionHours: 24,
      skippedRetentionHours: 6,
    })
  },
}
