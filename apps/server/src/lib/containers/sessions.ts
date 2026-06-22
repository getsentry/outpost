// Shared session persistence logic.
// Used by both the HTTP endpoint (POST /api/containers/sessions)
// and the outbound interception handler (jared.internal).

import { eq } from "drizzle-orm"
import type { DrizzleD1Database } from "drizzle-orm/d1"
import type * as dbSchema from "@/db/schema"
import { agentSessions } from "@/db/schema"

/**
 * Save (upsert) agent session data, merging messages by ID to avoid duplicates.
 */
export async function saveSession(
  db: DrizzleD1Database<typeof dbSchema>,
  entityKey: string,
  sessionData: string,
): Promise<void> {
  // Read existing session data to merge messages
  const existing = await db.query.agentSessions.findFirst({
    where: eq(agentSessions.entityKey, entityKey),
  })

  let mergedData = sessionData
  if (existing?.sessionData) {
    try {
      const oldData = JSON.parse(existing.sessionData) as Record<string, unknown>
      const newData = JSON.parse(sessionData) as Record<string, unknown>

      // Merge messages by ID, UPDATING existing messages in place. Assistant
      // messages stream in: an early sync captures them with empty/partial parts,
      // and later syncs return the same message ID with more parts. We must
      // replace the stored copy with the richer one (more parts wins) — otherwise
      // the agent's response never appears. Older messages beyond the fetch limit
      // are preserved.
      type Msg = Record<string, unknown>
      const oldMsgs = (oldData.messages ?? {}) as Record<string, Msg[]>
      const newMsgs = (newData.messages ?? {}) as Record<string, Msg[]>

      const idOf = (m: Msg): string | undefined => (m.info as Msg | undefined)?.id as string | undefined
      const partCount = (m: Msg): number => (Array.isArray(m.parts) ? (m.parts as unknown[]).length : 0)

      const mergedMsgs: Record<string, Msg[]> = {}
      const sids = new Set([...Object.keys(oldMsgs), ...Object.keys(newMsgs)])
      for (const sid of sids) {
        const ordered: Msg[] = []
        const indexById = new Map<string, number>()
        const noId: Msg[] = []
        const add = (m: Msg) => {
          const id = idOf(m)
          if (!id) {
            noId.push(m)
            return
          }
          const idx = indexById.get(id)
          if (idx === undefined) {
            indexById.set(id, ordered.length)
            ordered.push(m)
          } else {
            // Keep the richer version so a mid-stream empty re-fetch never clobbers
            // already-populated content.
            ordered[idx] = partCount(m) >= partCount(ordered[idx]) ? m : ordered[idx]
          }
        }
        for (const m of oldMsgs[sid] ?? []) add(m)
        for (const m of newMsgs[sid] ?? []) add(m)
        mergedMsgs[sid] = [...ordered, ...noId]
      }

      mergedData = JSON.stringify({
        ...newData,
        messages: mergedMsgs,
      })
    } catch {
      // If parsing fails, just use the new data as-is
    }
  }

  const now = new Date()
  await db
    .insert(agentSessions)
    .values({
      entityKey,
      sessionId: null,
      sessionData: mergedData,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: agentSessions.entityKey,
      set: {
        sessionData: mergedData,
        updatedAt: now,
      },
    })
}

type AnyRecord = Record<string, unknown>

/**
 * Derive a session's summary metadata (agent, model, cost), falling back to the
 * data carried on its messages when the session object itself is incomplete.
 *
 * The container's `/session` endpoint sometimes returns a "pending" placeholder
 * (only `id` + `title`, no agent/model/cost) while the real conversation is
 * recorded under a different session id in the `messages` map. In that case the
 * session object alone reports `agent: null`, `model: null`, `cost: 0`, so we
 * reconstruct those fields from the assistant messages instead.
 */
export function summarizeSession(
  session: AnyRecord,
  messages: AnyRecord[] = [],
): { agent: string | null; model: string | null; cost: number } {
  const infos = messages
    .map((m) => (m.info ?? m) as AnyRecord)
    .filter((info): info is AnyRecord => !!info && typeof info === "object")

  // Prefer the explicit session fields, then fall back to whatever the messages
  // reported (the most recent assistant message wins for agent/model).
  let agent = typeof session.agent === "string" ? session.agent : null
  let model =
    typeof (session.model as AnyRecord | undefined)?.id === "string"
      ? ((session.model as AnyRecord).id as string)
      : null

  if (!agent || !model) {
    for (const info of infos) {
      if (!agent && typeof info.agent === "string") agent = info.agent
      if (!model && typeof info.modelID === "string") model = info.modelID
      if (agent && model) break
    }
  }

  // The session's own `cost` is authoritative when present and non-zero;
  // otherwise sum the per-message costs (assistant messages carry `cost`).
  const sessionCost = typeof session.cost === "number" ? session.cost : 0
  const messageCost = infos.reduce((sum, info) => sum + (typeof info.cost === "number" ? info.cost : 0), 0)

  return { agent, model, cost: sessionCost > 0 ? sessionCost : messageCost }
}
