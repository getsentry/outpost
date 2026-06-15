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
