import { eq } from "drizzle-orm"
import type { DrizzleD1Database } from "drizzle-orm/d1"
import * as schema from "@/db/schema"
import { destroyAgentGeneration, mayRunFollowUp } from "@/lib/agents/lifecycle"
import {
  type AgentWorkRecordInput,
  formatExecutionContract,
  listOpenAgentWork,
  recordAgentWork,
} from "@/lib/agents/work-items"
import { type DiscussionRecordInput, recordDiscussionObligation } from "@/lib/github/discussion-store"
import type { BaseEnvBindings } from "@/types/env/base"
import { type SandboxSetupOpts, saveInitialSession } from "./dispatch"
import { toAgentInstanceId } from "./ids"

/** RPCs may interleave at awaits. Recover the tail after errors so retries work. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation)
    this.tail = next.catch(() => {})
    return next
  }
}

export type SessionMessage =
  | { kind: "user"; body: string }
  | {
      kind: "signal"
      type: "schedule"
      body: string
      attributes: { scheduledAt: string }
    }

type Dependencies = {
  destroyAgent(): Promise<void>
  destroySandbox(): Promise<void>
  prepare(options: SandboxSetupOpts): Promise<void>
  admit(message: SessionMessage, headers: TraceHeaders): Promise<{ submissionId?: string }>
}
export type TraceHeaders = { "sentry-trace"?: string; baggage?: string; traceparent?: string }

/**
 * Lives in a separate, never-destroyed DO, not the conversation being deleted.
 * It owns preparation/admission/teardown ordering, while D1 fences delayed
 * reporters and survives failed cleanup or a coordinator restart.
 */
export class SessionController {
  private queue = new SerialQueue()
  private db: DrizzleD1Database<typeof schema>
  private entityKey: string
  private dependencies: Dependencies

  constructor(db: DrizzleD1Database<typeof schema>, entityKey: string, dependencies: Dependencies) {
    this.db = db
    this.entityKey = entityKey
    this.dependencies = dependencies
  }

  startSession(): Promise<number> {
    return this.queue.run(() => saveInitialSession(this.db, this.entityKey))
  }

  private active<T>(generation: number, operation: () => Promise<T>): Promise<T> {
    return this.queue.run(async () => {
      if (!(await mayRunFollowUp(this.db, toAgentInstanceId(this.entityKey), generation))) {
        throw new Error("This agent run was destroyed; send a new prompt to start again")
      }
      return operation()
    })
  }

  prepareSession(generation: number, options: SandboxSetupOpts): Promise<void> {
    if (options.entityKey !== this.entityKey) throw new Error("Session key mismatch")
    return this.active(generation, () => this.dependencies.prepare(options))
  }

  admitSession(generation: number, message: SessionMessage, headers: TraceHeaders) {
    return this.active(generation, () => this.dependencies.admit(message, headers))
  }

  recordSessionWork(generation: number, input: AgentWorkRecordInput): Promise<string> {
    if (input.entityKey !== this.entityKey) throw new Error("Session key mismatch")
    return this.active(generation, async () => {
      await recordAgentWork(this.db, input)
      return formatExecutionContract(await listOpenAgentWork(this.db, input))
    })
  }

  recordSessionDiscussion(generation: number, input: DiscussionRecordInput): Promise<void> {
    if (input.entityKey !== this.entityKey) throw new Error("Session key mismatch")
    return this.active(generation, () => recordDiscussionObligation(this.db, input))
  }

  recordSessionEvent(generation: number, input: typeof schema.webhookEvents.$inferInsert): Promise<void> {
    if (input.entityKey !== this.entityKey) throw new Error("Session key mismatch")
    return this.active(generation, async () => {
      await this.db.insert(schema.webhookEvents).values(input)
    })
  }

  destroySession(expectedGeneration: number): Promise<void> {
    return this.queue.run(async () => {
      const instanceId = toAgentInstanceId(this.entityKey)
      const record = await this.db.query.agentLifecycle.findFirst({
        where: eq(schema.agentLifecycle.instanceId, instanceId),
      })
      if ((record?.generation ?? 0) !== expectedGeneration)
        throw new Error("Run changed before Destroy; refresh and retry")
      // Older recycle/bulk-clear paths wrote tombstones without deleting the
      // durable conversation. Even an existing tombstone must be fully cleaned.
      await destroyAgentGeneration(this.db, instanceId, true)
      await this.dependencies.destroyAgent()
      await this.dependencies.destroySandbox()
      // One atomic batch: a fresh start cannot precede record deletion. On any
      // failure leave both the retryable row and the persistent pending fence.
      await this.db.batch([
        this.db.delete(schema.agentSessions).where(eq(schema.agentSessions.entityKey, this.entityKey)),
        this.db.delete(schema.webhookEvents).where(eq(schema.webhookEvents.entityKey, this.entityKey)),
        this.db
          .delete(schema.githubDiscussionObligations)
          .where(eq(schema.githubDiscussionObligations.entityKey, this.entityKey)),
        this.db.delete(schema.agentWorkItems).where(eq(schema.agentWorkItems.entityKey, this.entityKey)),
        this.db
          .update(schema.agentLifecycle)
          .set({ cleanupPending: false })
          .where(eq(schema.agentLifecycle.instanceId, instanceId)),
      ])
    })
  }
}

export type SessionControllerRpc = {
  [K in
    | "startSession"
    | "prepareSession"
    | "admitSession"
    | "recordSessionWork"
    | "recordSessionDiscussion"
    | "recordSessionEvent"
    | "destroySession"]: (
    entityKey: string,
    ...args: Parameters<SessionController[K]>
  ) => ReturnType<SessionController[K]>
}

/** Colon cannot occur in a sanitized conversation id; control objects cannot collide with runs. */
export function sessionControllerId(entityKey: string): string {
  return `lifecycle:${toAgentInstanceId(entityKey)}`
}

export async function getSessionController(
  env: BaseEnvBindings["Bindings"],
  entityKey: string,
): Promise<SessionControllerRpc> {
  if (!env.FLUE_JARED_AGENT) throw new Error("Agent lifecycle runtime is unavailable")
  const { getAgentByName } = await import("agents")
  return (await getAgentByName(env.FLUE_JARED_AGENT, sessionControllerId(entityKey))) as unknown as SessionControllerRpc
}
