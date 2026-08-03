/**
 * Cloudflare deployment module for Flue.
 *
 * Named exports become top-level Worker exports (Durable Object classes).
 * The default export contributes non-HTTP handlers (scheduled / cron).
 */

import { dispatch } from "@flue/runtime"
import { Jared } from "./agents/jared.ts"

/** Re-export Sandbox DO (with outbound Workers) for Wrangler. */
export { Sandbox } from "./lib/containers/sandbox.ts"

/**
 * Cron / scheduled fires — used for recurring agent pings (CI polls, quiet-period
 * auto-merge nudges) when configured in wrangler triggers.crons.
 *
 * Per-conversation one-shots use Jared's DO scheduleFollowUp() instead.
 */
export default {
  async scheduled(controller: ScheduledController, env: { APP_URL?: string }) {
    await dispatch(Jared, {
      id: "cron-heartbeat",
      message: {
        kind: "signal",
        type: "schedule",
        body: "Scheduled ping: check for any draft PRs awaiting mark-pr-ready or auto-merge quiet-period completion. If nothing is actionable, reply SKIPPED: no work.",
        attributes: {
          cron: controller.cron,
          scheduledAt: new Date(controller.scheduledTime).toISOString(),
          appUrl: env.APP_URL ?? "",
        },
      },
    })
  },
}
