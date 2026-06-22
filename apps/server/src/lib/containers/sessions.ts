// Shared session persistence logic.
// Used by both the HTTP endpoint (POST /api/containers/sessions)
// and the outbound interception handler (jared.internal).

import { eq } from "drizzle-orm"
import type { DrizzleD1Database } from "drizzle-orm/d1"
import type * as dbSchema from "@/db/schema"
import { agentSessions } from "@/db/schema"

type AnyRecord = Record<string, unknown>

/**
 * Merge a previously-stored session blob with an incoming one. Pure function so
 * it can be unit-tested independently of D1.
 *
 *  - messages:      union by session-id key, then by message `info.id`
 *                   (richer/more-parts version wins) so streamed content is never
 *                   clobbered by a later partial re-fetch.
 *  - sessions:      union by session id. A recreated container makes OpenCode emit
 *                   a NEW session id, so a single sync only reports the current
 *                   session(s); replacing the array wholesale would drop every
 *                   prior session (orphaning its messages and dropping its cost
 *                   from totals). For ids in both, keep the richer/newer snapshot.
 *  - sessionStatus: latest sync is authoritative for sessions it reports; any
 *                   session NOT in the latest sync (e.g. from a now-dead container)
 *                   is forced non-busy so it never shows a permanent fake "busy".
 *
 * Returns the new blob unchanged if either side can't be parsed.
 */
export function mergeSessionData(oldRaw: string, newRaw: string): string {
  let oldData: AnyRecord
  let newData: AnyRecord
  try {
    oldData = JSON.parse(oldRaw) as AnyRecord
    newData = JSON.parse(newRaw) as AnyRecord
  } catch {
    return newRaw
  }

  type Msg = AnyRecord
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

  // Merge the sessions array by id (see doc comment above).
  type Session = AnyRecord
  const oldSessions = (Array.isArray(oldData.sessions) ? oldData.sessions : []) as Session[]
  const newSessions = (Array.isArray(newData.sessions) ? newData.sessions : []) as Session[]

  const sessionCost = (s: Session): number => (typeof s.cost === "number" ? s.cost : 0)
  const sessionUpdated = (s: Session): number =>
    typeof (s.time as Session | undefined)?.updated === "number" ? ((s.time as Session).updated as number) : 0
  // The new snapshot wins unless the old one is strictly richer (higher cost,
  // then more recently updated) — guards against a partial re-report blanking an
  // already-populated session.
  const richer = (a: Session, b: Session): Session => {
    if (sessionCost(a) !== sessionCost(b)) return sessionCost(a) > sessionCost(b) ? a : b
    return sessionUpdated(a) >= sessionUpdated(b) ? a : b
  }

  const sessionById = new Map<string, Session>()
  const sessionOrder: string[] = []
  const addSession = (s: Session) => {
    const id = typeof s.id === "string" ? s.id : undefined
    if (!id) return
    const prev = sessionById.get(id)
    if (prev) {
      sessionById.set(id, richer(s, prev))
    } else {
      sessionById.set(id, s)
      sessionOrder.push(id)
    }
  }
  for (const s of oldSessions) addSession(s)
  for (const s of newSessions) addSession(s)
  const mergedSessions = sessionOrder.map((id) => sessionById.get(id) as Session)

  // Merge sessionStatus by id (see doc comment above).
  const oldStatus = (oldData.sessionStatus ?? {}) as Record<string, AnyRecord>
  const newStatus = (newData.sessionStatus ?? {}) as Record<string, AnyRecord>
  const mergedStatus: Record<string, AnyRecord> = {}
  for (const id of Object.keys(oldStatus)) {
    mergedStatus[id] = id in newStatus ? newStatus[id] : { ...oldStatus[id], type: "idle" }
  }
  for (const id of Object.keys(newStatus)) {
    mergedStatus[id] = newStatus[id]
  }

  return JSON.stringify({
    ...newData,
    sessions: mergedSessions,
    sessionStatus: mergedStatus,
    messages: mergedMsgs,
  })
}

/**
 * Save (upsert) agent session data, merging with any existing row.
 */
export async function saveSession(
  db: DrizzleD1Database<typeof dbSchema>,
  entityKey: string,
  sessionData: string,
): Promise<void> {
  // Read existing session data so we can merge rather than overwrite.
  const existing = await db.query.agentSessions.findFirst({
    where: eq(agentSessions.entityKey, entityKey),
  })

  const mergedData = existing?.sessionData ? mergeSessionData(existing.sessionData, sessionData) : sessionData

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
