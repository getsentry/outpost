import { desc, eq, sql } from "drizzle-orm"
import { Hono } from "hono"
import { agentSessions } from "@/db/schema"
import { isAuthenticated } from "@/middlewares"
import type { BaseEnv } from "@/types"

// The save endpoint is unauthenticated (called from inside containers).
// All other endpoints require authentication.

const router = new Hono<BaseEnv>()
  // Unauthenticated: container posts session data here
  // Merges messages instead of replacing — appends new messages to existing ones
  .post("/save", async (c) => {
    const db = c.get("db")
    const body = (await c.req.json()) as {
      entityKey: string
      sessionData: string
    }

    if (!body.entityKey || !body.sessionData) {
      return c.json({ error: "entityKey and sessionData required" }, 400)
    }

    // Read existing session data to merge messages
    const existing = await db.query.agentSessions.findFirst({
      where: eq(agentSessions.entityKey, body.entityKey),
    })

    let mergedData = body.sessionData
    if (existing?.sessionData) {
      try {
        const oldData = JSON.parse(existing.sessionData) as Record<string, unknown>
        const newData = JSON.parse(body.sessionData) as Record<string, unknown>

        // Merge messages: for each session, collect unique messages by checking message ID
        const oldMsgs = (oldData.messages ?? {}) as Record<string, Array<Record<string, unknown>>>
        const newMsgs = (newData.messages ?? {}) as Record<string, Array<Record<string, unknown>>>

        const mergedMsgs: Record<string, Array<Record<string, unknown>>> = { ...oldMsgs }
        for (const [sid, msgs] of Object.entries(newMsgs)) {
          if (!mergedMsgs[sid]) {
            mergedMsgs[sid] = msgs
          } else {
            // Append messages not already present (check by info.id)
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

        // Use latest for everything else, merged for messages
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
        entityKey: body.entityKey,
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

    return c.json({ ok: true })
  })
  // Authenticated endpoints below
  .use(isAuthenticated())
  .get("/", async (c) => {
    const db = c.get("db")

    const page = Math.max(1, Number(c.req.query("page")) || 1)
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 25))
    const offset = (page - 1) * limit

    // Get sessions from agent_sessions table (populated by keepalive polling)
    const [sessions, countResult] = await Promise.all([
      db
        .select({
          entityKey: agentSessions.entityKey,
          sessionData: agentSessions.sessionData,
          createdAt: agentSessions.createdAt,
          updatedAt: agentSessions.updatedAt,
        })
        .from(agentSessions)
        .orderBy(desc(agentSessions.updatedAt))
        .limit(limit)
        .offset(offset),
      db.select({ count: sql<number>`count(*)` }).from(agentSessions),
    ])

    const total = countResult[0]?.count ?? 0

    // Parse sessionData JSON for each session to extract summary info
    const data = sessions.map((s) => {
      let parsed: Record<string, unknown> = {}
      try {
        parsed = JSON.parse(s.sessionData)
      } catch {
        /* empty */
      }
      return {
        entityKey: s.entityKey,
        sessionData: s.sessionData,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        // Extract summary fields from the stored JSON
        sessionStatus: parsed.sessionStatus ?? null,
        sessions: parsed.sessions ?? null,
        logs: parsed.logs ?? null,
      }
    })

    return c.json({
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    })
  })
  .get("/detail", async (c) => {
    const db = c.get("db")
    const entityKey = c.req.query("entityKey")
    if (!entityKey) {
      return c.json({ error: "entityKey query parameter required" }, 400)
    }

    const session = await db.query.agentSessions.findFirst({
      where: eq(agentSessions.entityKey, entityKey),
    })

    if (!session) {
      return c.json({ error: "Session not found" }, 404)
    }

    return c.json(session)
  })

export default router
