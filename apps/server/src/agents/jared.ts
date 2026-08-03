'use agent'

import { env } from "cloudflare:workers"
import { type AgentProps, dispatch, useModel, useSandbox, useSubagent } from "@flue/runtime"
import { cloudflareSandbox, extend } from "@flue/runtime/cloudflare"
import { getSandbox } from "@cloudflare/sandbox"
import * as Sentry from "@sentry/cloudflare"
import { exploreSubagent } from "./explore.ts"
import { JARED_INSTRUCTIONS } from "./instructions.ts"
import { workerSubagent } from "./worker.ts"

interface Env {
  Sandbox: DurableObjectNamespace
  SENTRY_DSN?: string
}

/**
 * Jared — primary GitHub coding agent.
 *
 * Runs as a Flue Durable Object on Cloudflare. Filesystem/shell work happens
 * in an attached Cloudflare Sandbox container (git, gh, node, ripgrep).
 * Conversation state lives in DO SQLite — no curl-scraping required.
 */
export function Jared({ id }: AgentProps) {
  useModel("openrouter/anthropic/claude-opus-4.8")

  const { Sandbox } = env as unknown as Env
  useSandbox(cloudflareSandbox(getSandbox(Sandbox, id), { cwd: "/workspace/repo" }))

  useSubagent(exploreSubagent)
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
