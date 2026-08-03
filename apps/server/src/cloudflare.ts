/**
 * Authored Worker composition for Flue.
 *
 * Named exports become top-level Worker exports (alongside Flue-generated
 * agent DO classes). The default export contributes non-HTTP handlers only —
 * do NOT export fetch here (that lives in app.ts).
 *
 * Application-wide cron is disabled in wrangler (empty crons). Use Jared's
 * scheduleFollowUp() for per-conversation quiet-period / CI follow-ups.
 */

export { Sandbox } from "./lib/containers/sandbox.ts"

export default {
  // Reserved for future platform scheduled handlers. Keep empty so a misfired
  // cron cannot attach a sandbox via Jared.
}
