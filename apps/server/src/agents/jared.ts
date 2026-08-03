'use agent'

import { env } from "cloudflare:workers"
import { type AgentProps, dispatch, useModel, useSandbox, useSubagent } from "@flue/runtime"
import { cloudflareSandbox, extend } from "@flue/runtime/cloudflare"
import { getSandbox } from "@cloudflare/sandbox"
import * as Sentry from "@sentry/cloudflare"
import { exploreSubagent } from "./explore.ts"
import { implementSubagent, workerSubagent } from "./implement.ts"
import { JARED_INSTRUCTIONS } from "./instructions.ts"
import { Models } from "./models.ts"
import { shipSubagent } from "./ship.ts"

interface Env {
  Sandbox: DurableObjectNamespace
  SENTRY_DSN?: string
}

/**
 * Jared — primary GitHub coding agent (Opus 4.8).
 *
 * Owns triage, planning, and go/no-go review. Delegates:
 *   explore   → Sonnet 4.6 (read-only survey)
 *   implement → Opus 4.6  (apply plan + tests)
 *   ship      → xAI Grok  (commit / push / draft PR)
 *
 * Runs as a Flue Durable Object. Filesystem/shell work happens in an attached
 * Cloudflare Sandbox container. Conversation state lives in DO SQLite.
 */
export function Jared({ id }: AgentProps) {
  useModel(Models.triage)

  const { Sandbox } = env as unknown as Env
  useSandbox(cloudflareSandbox(getSandbox(Sandbox, id), { cwd: "/workspace/repo" }))

  useSubagent(exploreSubagent)
  useSubagent(implementSubagent)
  useSubagent(shipSubagent)
  // Migration alias so older prompts that still say `worker` resolve.
  useSubagent(workerSubagent)

  return JARED_INSTRUCTIONS
}

Jared.agentName = "jared"

/**
 * Cloudflare Agents SDK extension:
 * - schedule()/scheduleEvery() for quiet-period auto-merge and CI follow-ups
 * - Sentry instrumentation of the generated Durable Object
 */
export const cloudflare = extend({
  base: (Base) =>
    class extends Base {
      /** One-shot follow-up (e.g. auto-merge quiet period). */
      async scheduleFollowUp(delaySeconds: number, prompt: string) {
        await this.schedule(delaySeconds, "runFollowUp", { prompt })
      }

      async runFollowUp(payload: { prompt: string }) {
        await dispatch(Jared, {
          id: this.name,
          message: {
            kind: "signal",
            type: "schedule",
            body: payload.prompt,
            attributes: { scheduledAt: new Date().toISOString() },
          },
        })
      }
    },
  wrap: (Final) =>
    Sentry.instrumentDurableObjectWithSentry(
      (bindings: Env) => ({
        dsn: bindings.SENTRY_DSN,
      }),
      Final,
    ),
})
