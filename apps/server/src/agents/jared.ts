"use agent"

import { env } from "cloudflare:workers"
import { getSandbox } from "@cloudflare/sandbox"
import { type AgentProps, dispatch, useDelivery, useModel, useSandbox, useSubagent } from "@flue/runtime"
import { cloudflareSandbox, extend } from "@flue/runtime/cloudflare"
import * as Sentry from "@sentry/cloudflare"
import { exploreSubagent } from "./explore.ts"
import { implementSubagent, workerSubagent } from "./implement.ts"
import { JARED_INSTRUCTIONS } from "./instructions.ts"
import { modelForDelivery } from "./models.ts"
import { shipSubagent } from "./ship.ts"

interface Env {
  Sandbox: DurableObjectNamespace
  SENTRY_DSN?: string
}

/**
 * Jared — primary GitHub coding agent.
 *
 * Owns triage, planning, and go/no-go review. The primary model is chosen per
 * event: heavy (Opus) for code-producing situations, a cheaper model (grok) for
 * lightweight ones (comment replies, approvals). Delegates:
 *   explore   → gpt-5-mini      (read-only survey)
 *   implement → kimi-k2.7-code  (apply plan + tests)
 *   ship      → xAI grok-build  (commit / push / draft PR)
 *
 * `id` is the Flue conversation id — the SAME sanitized entity key used when
 * the Worker clones the repo via getSandbox(Sandbox, id). Do not re-sanitize.
 */
export function Jared({ id }: AgentProps) {
  useModel(modelForDelivery(useDelivery()))

  const { Sandbox } = env as unknown as Env
  // Match prep options in github/dispatch.ts (normalizeId + short idle teardown).
  // The container is disposable: it tears down ~10m after the last exec, and this
  // conversation (the durable brain) persists in the DO, so the next event resumes
  // context and re-clones the repo into a fresh sandbox.
  useSandbox(
    cloudflareSandbox(getSandbox(Sandbox, id, { normalizeId: true, sleepAfter: "10m" }), {
      cwd: "/workspace/repo",
    }),
  )

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
