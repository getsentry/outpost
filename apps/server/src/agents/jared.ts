"use agent"

import { env } from "cloudflare:workers"
import { getSandbox } from "@cloudflare/sandbox"
import {
  type AgentProps,
  useAgentFinish,
  useAgentStart,
  useDelivery,
  useModel,
  useSandbox,
  useSubagent,
} from "@flue/runtime"
import { cloudflareSandbox, extend } from "@flue/runtime/cloudflare"
import * as Sentry from "@sentry/cloudflare"
import { drizzle } from "drizzle-orm/d1"
import * as dbSchema from "@/db/schema"
import { mayRunFollowUp } from "@/lib/agents/lifecycle"
import type { AgentWorkRecordInput } from "@/lib/agents/work-items"
import { dispatchPrompt, ensureSandboxReady, type SandboxSetupOpts } from "@/lib/containers/dispatch"
import { toAgentInstanceId } from "@/lib/containers/ids"
import { SANDBOX_OPTS } from "@/lib/containers/sandbox-opts"
import {
  getSessionController,
  SerialQueue,
  SessionController,
  type SessionMessage,
  sessionControllerId,
  type TraceHeaders,
} from "@/lib/containers/session-controller"
import { acknowledgeWorkspaceLoss, workspaceStore } from "@/lib/containers/workspace-checkpoint"
import { assertWorkspaceUsable, currentWorkspace, recoverableSandbox } from "@/lib/containers/workspace-runtime"
import type { DiscussionRecordInput } from "@/lib/github/discussion-store"
import { cloudflareSentryOptions } from "@/lib/observability/cloudflare"
import {
  classifySandboxPreparationFailure,
  sandboxPreparationAttributes,
  workflowCorrelationTags,
} from "@/lib/observability/sentry"
import type { BaseEnvBindings } from "@/types/env/base"
import "./sentry.ts"
import { exploreSubagent } from "./explore.ts"
import { implementSubagent, workerSubagent } from "./implement.ts"
import { JARED_INSTRUCTIONS } from "./instructions.ts"
import { modelForDelivery } from "./models.ts"
import { shipSubagent } from "./ship.ts"

interface Env {
  Sandbox: DurableObjectNamespace
  DB: D1Database
  SENTRY_DSN?: string
}

/**
 * Jared — primary GitHub coding agent.
 *
 * Owns triage, planning, and go/no-go review. The primary model is chosen per
 * event: heavy (Opus) for all GitHub conversation work, with the cheaper Grok
 * tier reserved for completed successful CI. Delegates:
 *   explore   → gpt-5-mini      (read-only survey)
 *   implement → kimi-k2.7-code  (apply plan + tests)
 *   ship      → xAI grok-build  (commit / push / draft PR)
 *
 * `id` is the Flue conversation id — the SAME sanitized entity key used when
 * the Worker clones the repo via getSandbox(Sandbox, id). Do not re-sanitize.
 */
export function Jared({ id }: AgentProps) {
  // A lost workspace is not a model-retry problem. Fail before another model
  // call (including after a tool error) instead of burning dozens of retries.
  assertWorkspaceUsable()
  const delivery = useDelivery()
  useModel(modelForDelivery(delivery))

  const { Sandbox } = env as unknown as Env
  const sandbox = getSandbox(Sandbox, id, SANDBOX_OPTS)
  // The submission interceptor holds a bounded keepalive lease. Every shared
  // subagent tool uses the recovery guard around Flue's native adapter.
  useSandbox(
    recoverableSandbox(
      cloudflareSandbox(sandbox, {
        cwd: "/workspace/repo",
      }),
      sandbox,
    ),
  )

  // Webhook turns are prepped by the Worker before dispatch, but DO-initiated
  // turns (scheduled auto-merge/fix-ci follow-ups) and post-teardown resumes reach
  // the DO with a possibly-empty container. Re-clone + re-auth before the model's
  // first turn so git/gh work. `force` on non-user deliveries also refreshes the
  // ~1h GitHub token for long-delayed follow-ups.
  useAgentStart(async ({ signal }) => {
    await Sentry.startSpan(
      {
        name: "jared.sandbox.prepare",
        op: "jared.sandbox.prepare",
        attributes: sandboxPreparationAttributes({
          source: "durable_object_agent_start",
          sandboxId: id,
          entityKey: id,
          lifecycleStatus: "preparing",
        }),
      },
      async (span) => {
        try {
          await currentWorkspace().start(delivery?.kind !== "user", signal)
          span.setAttribute("jared.sandbox.outcome", "prepared")
        } catch (error) {
          span.setAttribute("jared.sandbox.outcome", "failed")
          span.setAttribute("jared.sandbox.failure_class", classifySandboxPreparationFailure(error))
          throw error
        }
      },
    )
  })

  // Also enforce the outcome if the model stops immediately after a tool error.
  useAgentFinish(() => currentWorkspace().assertUsable())

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
  base: (Base) => {
    // Flue's extension type omits these inherited Agents SDK members.
    const SdkBase = Base as unknown as new (
      ...args: ConstructorParameters<typeof Base>
    ) => InstanceType<typeof Base> & { readonly name: string; destroy(): Promise<void> }
    return class extends SdkBase {
      private ownerQueue = new SerialQueue()
      private closing = false
      private controller: SessionController | undefined
      private controllerKey: string | undefined

      private controllerFor(entityKey: string): SessionController {
        if (this.name !== sessionControllerId(entityKey)) throw new Error("Invalid lifecycle owner")
        if (this.controllerKey && this.controllerKey !== entityKey) throw new Error("Session key collision")
        this.controllerKey = entityKey
        const bindings = env as unknown as BaseEnvBindings["Bindings"]
        const instanceId = toAgentInstanceId(entityKey)
        this.controller ??= new SessionController(drizzle(bindings.DB, { schema: dbSchema }), entityKey, {
          destroyAgent: async () => {
            const agent = bindings.FLUE_JARED_AGENT!.get(
              bindings.FLUE_JARED_AGENT!.idFromName(instanceId),
            ) as unknown as { destroy(): Promise<void> }
            await agent.destroy()
          },
          destroySandbox: () => getSandbox(bindings.Sandbox, instanceId, SANDBOX_OPTS).destroy(),
          prepare: (options) => ensureSandboxReady(getSandbox(bindings.Sandbox, instanceId, SANDBOX_OPTS), options),
          admit: async (message, headers) => {
            if (bindings.FLUE_NATIVE !== "1" && bindings.FLUE_NATIVE !== "true") {
              const submissionId = crypto.randomUUID()
              await dispatchPrompt(
                getSandbox(bindings.Sandbox, instanceId, SANDBOX_OPTS),
                entityKey,
                message.body,
                submissionId,
              )
              return { submissionId }
            }
            const { getAgentByName } = await import("agents")
            const agent = await getAgentByName(bindings.FLUE_JARED_AGENT!, instanceId)
            const response = await agent.fetch(
              new Request(`https://flue.internal/agents/jared/${instanceId}`, {
                method: "POST",
                headers: { ...headers, "content-type": "application/json" },
                body: JSON.stringify(message),
              }),
            )
            if (!response.ok) throw new Error(`Agent admission failed (${response.status})`)
            return (await response.json()) as { submissionId?: string }
          },
        })
        return this.controller
      }

      startSession(entityKey: string) {
        return this.controllerFor(entityKey).startSession()
      }
      prepareSession(entityKey: string, generation: number, options: SandboxSetupOpts) {
        return this.controllerFor(entityKey).prepareSession(generation, options)
      }
      admitSession(entityKey: string, generation: number, message: SessionMessage, headers: TraceHeaders) {
        return this.controllerFor(entityKey).admitSession(generation, message, headers)
      }
      recordSessionWork(entityKey: string, generation: number, input: AgentWorkRecordInput) {
        return this.controllerFor(entityKey).recordSessionWork(generation, input)
      }
      recordSessionDiscussion(entityKey: string, generation: number, input: DiscussionRecordInput) {
        return this.controllerFor(entityKey).recordSessionDiscussion(generation, input)
      }
      recordSessionEvent(entityKey: string, generation: number, input: typeof dbSchema.webhookEvents.$inferInsert) {
        return this.controllerFor(entityKey).recordSessionEvent(generation, input)
      }
      destroySession(entityKey: string, generation: number) {
        return this.controllerFor(entityKey).destroySession(generation)
      }

      override async destroy() {
        this.closing = true
        await this.ownerQueue.run(() => super.destroy())
      }

      /** Called only by the authenticated operator route after settlement. */
      acknowledgeWorkspaceLoss(runId: string) {
        return acknowledgeWorkspaceLoss(workspaceStore(this.ctx.storage.sql), runId, this.ctx.storage.sql)
      }

      /** One-shot follow-up (e.g. auto-merge quiet period). */
      async scheduleFollowUp(delaySeconds: number, prompt: string) {
        const db = drizzle((env as unknown as Env).DB, { schema: dbSchema })
        await this.ownerQueue.run(async () => {
          if (this.closing) throw new Error("Agent run is being destroyed")
          const record = await db.query.agentLifecycle.findFirst({
            where: (table, { eq }) => eq(table.instanceId, this.name),
          })
          const generation = record?.generation ?? 0
          if (record?.destroyedAt || this.closing) throw new Error("Agent run was destroyed")
          await Sentry.startSpan(
            {
              name: "jared.follow_up.schedule",
              op: "jared.follow_up.schedule",
              attributes: workflowCorrelationTags({
                source: "durable_object_schedule",
                entityKey: this.name,
                generation,
                lifecycleStatus: "scheduled",
              }),
            },
            () => this.schedule(delaySeconds, "runFollowUp", { prompt, generation }),
          )
        })
      }

      async runFollowUp(payload: { prompt: string; generation?: number }) {
        const db = drizzle((env as unknown as Env).DB, { schema: dbSchema })
        await Sentry.startSpan(
          {
            name: "jared.follow_up.admit",
            op: "jared.follow_up.admit",
            attributes: workflowCorrelationTags({
              source: "durable_object_follow_up",
              entityKey: this.name,
              generation: payload.generation,
              lifecycleStatus: "admitting",
            }),
          },
          async (span) => {
            if (!(await mayRunFollowUp(db, this.name, payload.generation ?? 0))) {
              span.setAttribute("jared.lifecycle_status", "dropped")
              console.info("jared: dropped follow-up for destroyed generation", {
                id: this.name,
                generation: payload.generation,
              })
              return
            }
            // Never hold ownerQueue while awaiting the coordinator: teardown
            // calls back into this owner's destroy RPC.
            const row = await db.query.agentSessions.findFirst({
              where: (table, { eq }) => eq(table.sessionId, this.name),
              columns: { entityKey: true },
            })
            if (!row || this.closing) return
            const controller = await getSessionController(env as unknown as BaseEnvBindings["Bindings"], row.entityKey)
            await controller.admitSession(
              row.entityKey,
              payload.generation ?? 0,
              {
                kind: "signal",
                type: "schedule",
                body: payload.prompt,
                attributes: { scheduledAt: new Date().toISOString() },
              },
              Sentry.getTraceData({ propagateTraceparent: true }),
            )
            span.setAttribute("jared.lifecycle_status", "admitted")
          },
        )
      }
    }
  },
  wrap: (Final) =>
    Sentry.instrumentDurableObjectWithSentry((bindings: Env) => cloudflareSentryOptions(bindings), Final),
})
