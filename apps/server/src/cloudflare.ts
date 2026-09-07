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

import * as Sentry from "@sentry/cloudflare"
import { retryOpenDiscussionObligations } from "./lib/events/discussion-retry.ts"
import { recordMaintenanceRun } from "./lib/events/maintenance.ts"
import { reconcileStuckDispatched } from "./lib/events/reconcile.ts"
import { deleteExpiredWebhookEvents } from "./lib/events/retention.ts"
import { cloudflareSentryOptions } from "./lib/observability/cloudflare.ts"
import type { BaseEnvBindings } from "./types/env/base.ts"

// ContainerProxy is a WorkerEntrypoint the Sandbox DO reaches via
// `ctx.exports.ContainerProxy` to build outbound-interception fetchers (see
// JaredSandbox.outboundByHost). It MUST be a top-level Worker export or the
// container fails to start with "ctx.exports.ContainerProxy is undefined".
export { ContainerProxy } from "@cloudflare/sandbox"
export { Sandbox } from "./lib/containers/sandbox.ts"

const handlers = {
  async scheduled(
    controller: ScheduledController,
    env: BaseEnvBindings["Bindings"],
    _ctx: ExecutionContext,
  ): Promise<void> {
    return Sentry.startSpan(
      {
        name: "jared.maintenance.heartbeat",
        op: "jared.maintenance.heartbeat",
        attributes: {
          "jared.source": "scheduled_maintenance",
          "jared.lifecycle_status": "running",
          "jared.cron": controller.cron,
        },
      },
      async (span) => {
        let discussionRetries = { retried: 0, needsHuman: 0 }
        try {
          discussionRetries = await retryOpenDiscussionObligations(env, controller.scheduledTime)
        } catch (_err) {
          console.warn("github_discussion_obligations.retry.failed", { failure_class: "contained" })
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

        // Long-lived admitted rows (>2h) are reconciled against their exact Flue
        // settlement receipt. This never turns an idle conversation into blanket
        // delivery success. Unsettled submissions still time out visibly.
        let reconciled = { entities: 0, settled: 0, timedOut: 0 }
        try {
          reconciled = await reconcileStuckDispatched(env, controller.scheduledTime)
        } catch (_err) {
          console.warn("webhook_events.reconcile.failed", { failure_class: "contained" })
          const dispatchedCutoff = Math.floor((controller.scheduledTime - 2 * 60 * 60 * 1000) / 1000)
          const fallback = await env.DB.prepare(
            "UPDATE webhook_events SET status = 'failed:timeout', completed_at = ? WHERE (status IN ('dispatched', 'admitted') OR status LIKE 'admitted:%') AND dispatched_at < ?",
          )
            .bind(Math.floor(controller.scheduledTime / 1000), dispatchedCutoff)
            .run()
          reconciled.timedOut = fallback.meta.changes ?? 0
        }

        console.info("webhook_events.retention.completed", {
          cron: controller.cron,
          deleted,
          timedOut: (stuck.meta.changes ?? 0) + reconciled.timedOut,
          reconciledSettled: reconciled.settled,
          reconciledEntities: reconciled.entities,
          discussionRetries: discussionRetries.retried,
          discussionNeedsHuman: discussionRetries.needsHuman,
          actionableRetentionHours: 24,
          skippedRetentionHours: 6,
        })

        try {
          await recordMaintenanceRun(env.DB, {
            cron: controller.cron,
            scheduledAt: controller.scheduledTime,
            deleted,
            timedOut: (stuck.meta.changes ?? 0) + reconciled.timedOut,
            settled: reconciled.settled,
            discussionRetries: discussionRetries.retried,
          })
        } catch (_err) {
          console.warn("maintenance_runs.record.failed", { failure_class: "contained" })
        }
        span.setAttribute("jared.lifecycle_status", "completed")
        span.setAttribute("jared.maintenance.deleted", deleted)
        span.setAttribute("jared.maintenance.timed_out", (stuck.meta.changes ?? 0) + reconciled.timedOut)
        span.setAttribute("jared.maintenance.settled", reconciled.settled)
      },
    )
  },
}

export default Sentry.withSentry((env: BaseEnvBindings["Bindings"]) => cloudflareSentryOptions(env), handlers)
