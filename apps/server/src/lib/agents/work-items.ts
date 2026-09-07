import { and, asc, eq, notInArray, or } from "drizzle-orm"
import type { DrizzleD1Database } from "drizzle-orm/d1"
import * as dbSchema from "@/db/schema"

/**
 * A durable, human-originated unit of work. Work state is intentionally
 * separate from a sandbox/entity key: a pull request can share its live
 * conversation with a linked issue without losing its own completion target.
 */
export const WORK_STAGES = [
  "queued",
  "planning",
  "implementing",
  "validating",
  "awaiting_ci",
  "awaiting_human",
  "blocked",
  "completed",
  "cancelled",
] as const

export type WorkStage = (typeof WORK_STAGES)[number]

export type ExecutionContractItem = {
  id: string
  goal: string
  stage: WorkStage
  targetPrNumber: number | null
}

export type AgentWorkRecordInput = {
  id?: string
  workKey: string
  entityKey: string
  repo: string
  sourceKind: "github" | "dashboard"
  sourceId: string
  goal: string
  targetPrNumber?: number | null
  now?: Date
}

/** Human input is operational state, not a transcript. Keep its size bounded. */
export const MAX_WORK_GOAL_LENGTH = 8_000

/** Bound a resumed turn even if a busy PR receives many long-lived requests. */
export const MAX_EXECUTION_CONTRACT_LENGTH = 16_000

/** Avoid an unbounded D1 read before the prompt formatter applies its byte cap. */
export const MAX_OPEN_WORK_ITEMS = 25

type Db = DrizzleD1Database<typeof dbSchema>

export function makeAgentWorkRecord(input: AgentWorkRecordInput) {
  const now = input.now ?? new Date()
  return {
    id: input.id ?? crypto.randomUUID(),
    workKey: input.workKey,
    entityKey: input.entityKey,
    repo: input.repo,
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    goal: input.goal.slice(0, MAX_WORK_GOAL_LENGTH),
    targetPrNumber: input.targetPrNumber ?? null,
    stage: "queued" as WorkStage,
    artifactUrl: null,
    artifactSha: null,
    blocker: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  }
}

/** Stable source identity shared by GitHub admission and completion evidence. */
export function githubWorkSourceId(kind: string, sourceCommentId: string): string {
  return `${kind}:${sourceCommentId}`
}

/**
 * A GitHub redelivery or edit must not reset a task that has already progressed.
 * The unique source key refreshes the human's latest wording without changing
 * the stage or completion evidence.
 */
export async function recordAgentWork(db: Db, input: AgentWorkRecordInput): Promise<void> {
  const record = makeAgentWorkRecord(input)
  await db
    .insert(dbSchema.agentWorkItems)
    .values(record)
    .onConflictDoUpdate({
      target: [dbSchema.agentWorkItems.repo, dbSchema.agentWorkItems.sourceKind, dbSchema.agentWorkItems.sourceId],
      set: {
        workKey: record.workKey,
        entityKey: record.entityKey,
        goal: record.goal,
        targetPrNumber: record.targetPrNumber,
        updatedAt: record.updatedAt,
      },
    })
}

/**
 * Retrieve open tasks by either their stable work key or the live conversation
 * key. The latter preserves continuity for legacy issue/PR shared sessions.
 */
export async function listOpenAgentWork(
  db: Db,
  opts: { workKey: string; entityKey: string },
): Promise<ExecutionContractItem[]> {
  const rows = await db
    .select({
      id: dbSchema.agentWorkItems.id,
      goal: dbSchema.agentWorkItems.goal,
      stage: dbSchema.agentWorkItems.stage,
      targetPrNumber: dbSchema.agentWorkItems.targetPrNumber,
    })
    .from(dbSchema.agentWorkItems)
    .where(
      and(
        or(eq(dbSchema.agentWorkItems.workKey, opts.workKey), eq(dbSchema.agentWorkItems.entityKey, opts.entityKey)),
        notInArray(dbSchema.agentWorkItems.stage, ["completed", "cancelled"]),
      ),
    )
    .orderBy(asc(dbSchema.agentWorkItems.createdAt))
    .limit(MAX_OPEN_WORK_ITEMS)

  return rows.map((row) => ({
    id: row.id,
    goal: row.goal,
    stage: row.stage as WorkStage,
    targetPrNumber: row.targetPrNumber,
  }))
}

export async function completeAgentWorkFromGitHubDiscussion(
  db: Db,
  opts: { repo: string; kind: string; sourceCommentId: string; now?: Date },
): Promise<void> {
  const now = opts.now ?? new Date()
  await db
    .update(dbSchema.agentWorkItems)
    .set({ stage: "completed", completedAt: now, updatedAt: now, blocker: null })
    .where(
      and(
        eq(dbSchema.agentWorkItems.repo, opts.repo),
        eq(dbSchema.agentWorkItems.sourceKind, "github"),
        eq(dbSchema.agentWorkItems.sourceId, githubWorkSourceId(opts.kind, opts.sourceCommentId)),
        notInArray(dbSchema.agentWorkItems.stage, ["completed", "cancelled"]),
      ),
    )
}

export async function cancelAgentWorkFromGitHubSource(
  db: Db,
  opts: { repo: string; kind: string; sourceCommentId: string; now?: Date },
): Promise<void> {
  const now = opts.now ?? new Date()
  await db
    .update(dbSchema.agentWorkItems)
    .set({ stage: "cancelled", completedAt: now, updatedAt: now, blocker: "The source discussion was deleted." })
    .where(
      and(
        eq(dbSchema.agentWorkItems.repo, opts.repo),
        eq(dbSchema.agentWorkItems.sourceKind, "github"),
        eq(dbSchema.agentWorkItems.sourceId, githubWorkSourceId(opts.kind, opts.sourceCommentId)),
        notInArray(dbSchema.agentWorkItems.stage, ["completed", "cancelled"]),
      ),
    )
}

export function isTerminalWorkStage(stage: WorkStage): boolean {
  return stage === "completed" || stage === "cancelled"
}

/**
 * Keep review/PR work pinned to the PR even when entity affinity intentionally
 * routes its live conversation through a linked issue.
 */
export function canonicalWorkKey(opts: { repo: string; entityKey: string; prNumber?: number | null }): string {
  return opts.prNumber ? `${opts.repo}#pr-${opts.prNumber}` : opts.entityKey
}

/**
 * Injected into every admitted turn. This is compact, content-bounded durable
 * state, rather than a second copy of a conversation transcript.
 */
export function formatExecutionContract(items: ExecutionContractItem[]): string {
  if (items.length === 0) return ""

  const header = `## Durable execution contract

The following human-requested work is still open. Continue it in the listed
order before treating the event as informational. Do not replace this with a status-only reply: inspect, make the requested change when authorized, validate it, and leave the relevant remote artifact or a concrete blocker.

`
  const overflowNote = "\n\nAdditional open work remains; finish or unblock the listed work, then reload the contract."
  const rendered: string[] = []
  for (const item of items) {
    const target = item.targetPrNumber ? `\n  Target pull request: #${item.targetPrNumber}` : ""
    const entry = `- Work ${item.id} [${item.stage}]${target}\n  Goal: ${item.goal}`
    if (
      header.length + rendered.join("\n").length + entry.length + overflowNote.length >
      MAX_EXECUTION_CONTRACT_LENGTH
    ) {
      break
    }
    rendered.push(entry)
  }

  const remaining = items.length - rendered.length
  const overflow = remaining > 0 ? overflowNote : ""

  return `${header}${rendered.join("\n")}${overflow}`
}
