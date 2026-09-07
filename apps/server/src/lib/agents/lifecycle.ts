import { eq } from "drizzle-orm"
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
  const existing = await db.query.agentLifecycle.findFirst({
    where: eq(dbSchema.agentLifecycle.instanceId, instanceId),
  })
  const now = new Date()
  if (!existing) {
    await db.insert(dbSchema.agentLifecycle).values({
      instanceId,
      generation: 1,
      destroyedAt: null,
      updatedAt: now,
    })
    return 1
  }

  const generation = nextGenerationAfterStart(existing)
  if (generation !== existing.generation || existing.destroyedAt) {
    await db
      .update(dbSchema.agentLifecycle)
      .set({ generation, destroyedAt: null, updatedAt: now })
      .where(eq(dbSchema.agentLifecycle.instanceId, instanceId))
  }
  return generation
}

export async function destroyAgentGeneration(db: Db, instanceId: string): Promise<void> {
  const existing = await db.query.agentLifecycle.findFirst({
    where: eq(dbSchema.agentLifecycle.instanceId, instanceId),
  })
  const now = new Date()
  if (!existing) {
    await db.insert(dbSchema.agentLifecycle).values({
      instanceId,
      generation: 1,
      destroyedAt: now,
      updatedAt: now,
    })
    return
  }
  await db
    .update(dbSchema.agentLifecycle)
    .set({ destroyedAt: now, updatedAt: now })
    .where(eq(dbSchema.agentLifecycle.instanceId, instanceId))
}

export async function mayRunFollowUp(db: Db, instanceId: string, generation: number): Promise<boolean> {
  const record = await db.query.agentLifecycle.findFirst({
    where: eq(dbSchema.agentLifecycle.instanceId, instanceId),
  })
  return mayRunFollowUpFromRecord(record ?? null, generation)
}
