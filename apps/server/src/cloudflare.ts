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

import { deleteExpiredWebhookEvents } from "./lib/events/retention.ts"

// ContainerProxy is a WorkerEntrypoint the Sandbox DO reaches via
// `ctx.exports.ContainerProxy` to build outbound-interception fetchers (see
// JaredSandbox.outboundByHost). It MUST be a top-level Worker export or the
// container fails to start with "ctx.exports.ContainerProxy is undefined".
export { ContainerProxy } from "@cloudflare/sandbox"
export { Sandbox } from "./lib/containers/sandbox.ts"

export default {
  async scheduled(controller: ScheduledController, env: { DB: D1Database }, _ctx: ExecutionContext): Promise<void> {
    const deleted = await deleteExpiredWebhookEvents(env.DB, controller.scheduledTime)
    // Also mark stuck intermediate dispatch statuses as timed out (>30m),
    // and long-lived `dispatched` rows that never completed (>2h).
    const stuckCutoff = Math.floor((controller.scheduledTime - 30 * 60 * 1000) / 1000)
    const stuck = await env.DB.prepare(
      "UPDATE webhook_events SET status = 'failed:timeout', completed_at = ? WHERE status LIKE 'd:%' AND created_at < ?",
    )
      .bind(Math.floor(controller.scheduledTime / 1000), stuckCutoff)
      .run()

    const dispatchedCutoff = Math.floor((controller.scheduledTime - 2 * 60 * 60 * 1000) / 1000)
    const stuckDispatched = await env.DB.prepare(
      "UPDATE webhook_events SET status = 'failed:timeout', completed_at = ? WHERE status = 'dispatched' AND dispatched_at < ?",
    )
      .bind(Math.floor(controller.scheduledTime / 1000), dispatchedCutoff)
      .run()

    console.info("webhook_events.retention.completed", {
      cron: controller.cron,
      deleted,
      timedOut: (stuck.meta.changes ?? 0) + (stuckDispatched.meta.changes ?? 0),
      actionableRetentionHours: 24,
      skippedRetentionHours: 6,
    })
  },
}
