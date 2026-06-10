// Shared session persistence logic.
// Used by both the HTTP endpoint (POST /api/containers/sessions)
// and the outbound interception handler (jared.internal).

import { eq } from "drizzle-orm"
import type { DrizzleD1Database } from "drizzle-orm/d1"
import { agentSessions } from "@/db/schema"
import type * as dbSchema from "@/db/schema"

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

      // Merge messages: for each session, collect unique messages by checking message ID
      const oldMsgs = (oldData.messages ?? {}) as Record<string, Array<Record<string, unknown>>>
      const newMsgs = (newData.messages ?? {}) as Record<string, Array<Record<string, unknown>>>

      const mergedMsgs: Record<string, Array<Record<string, unknown>>> = { ...oldMsgs }
      for (const [sid, msgs] of Object.entries(newMsgs)) {
        if (!mergedMsgs[sid]) {
          mergedMsgs[sid] = msgs
        } else {
          const existingIds = new Set(
            mergedMsgs[sid].map((m) => (m.info as Record<string, unknown>)?.id).filter(Boolean),
          )
          for (const msg of msgs) {
            const msgId = (msg.info as Record<string, unknown>)?.id
            if (!msgId || !existingIds.has(msgId)) {
              mergedMsgs[sid].push(msg)
              if (msgId) existingIds.add(msgId)
            }
          }
        }
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
