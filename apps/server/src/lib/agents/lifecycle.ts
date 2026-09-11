import { eq, sql } from "drizzle-orm"
import type { DrizzleD1Database } from "drizzle-orm/d1"
import * as dbSchema from "@/db/schema"

type Db = DrizzleD1Database<typeof dbSchema>

export type AgentLifecycleRecord = {
  generation: number
  destroyedAt: Date | null
}

/** A destroyed entity must start a new generation before delayed work can run. */
export function nextGenerationAfterStart(record: AgentLifecycleRecord): number {
  return record.destroyedAt ? record.generation + 1 : record.generation
}

/** A schedule belongs only to the active, non-destroyed generation. */
export function mayRunFollowUpFromRecord(record: AgentLifecycleRecord | null, generation: number): boolean {
  // Pre-migration schedules have no generation and remain compatible until an
  // explicit destroy writes their tombstone.
  return record === null ? generation === 0 : record.destroyedAt === null && record.generation === generation
}

export async function startAgentGeneration(db: Db, instanceId: string): Promise<number> {
  const now = Math.floor(Date.now() / 1000)
  const rows = await db.all<{ generation: number }>(sql`
    INSERT INTO agent_lifecycle (instance_id, generation, destroyed_at, cleanup_pending, updated_at)
    VALUES (${instanceId}, 1, NULL, 0, ${now})
    ON CONFLICT(instance_id) DO UPDATE SET
      generation = CASE WHEN destroyed_at IS NULL THEN generation ELSE generation + 1 END,
      destroyed_at = NULL, updated_at = excluded.updated_at
    WHERE cleanup_pending = 0
    RETURNING generation
  `)
  if (!rows[0]) throw new Error("Run cleanup is incomplete; retry Destroy before starting again")
  return rows[0].generation
}

export async function destroyAgentGeneration(db: Db, instanceId: string, cleanupPending = false): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  await db.run(sql`
    INSERT INTO agent_lifecycle (instance_id, generation, destroyed_at, cleanup_pending, updated_at)
    VALUES (${instanceId}, 1, ${now}, ${cleanupPending ? 1 : 0}, ${now})
    ON CONFLICT(instance_id) DO UPDATE SET
      destroyed_at = excluded.destroyed_at,
      cleanup_pending = MAX(cleanup_pending, excluded.cleanup_pending),
      updated_at = excluded.updated_at
  `)
}

export async function mayRunFollowUp(db: Db, instanceId: string, generation: number): Promise<boolean> {
  const record = await db.query.agentLifecycle.findFirst({
    where: eq(dbSchema.agentLifecycle.instanceId, instanceId),
  })
  return mayRunFollowUpFromRecord(record ?? null, generation)
}
