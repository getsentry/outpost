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
    console.info("webhook_events.retention.completed", {
      cron: controller.cron,
      deleted,
      cutoffHours: 24,
    })
  },
}
