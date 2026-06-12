// Container management routes.
//
// Groups all container-related operations under /api/containers:
//   POST /sessions         — unauthenticated, called from inside containers via
//                            jared.internal outbound interception or direct HTTP
//   GET  /sessions         — authenticated, paginated list of agent sessions
//   GET  /sessions/detail  — authenticated, single session detail by entityKey
//   GET  /:entityKey/debug — authenticated, live container inspection
//   POST /:entityKey/destroy — authenticated, force-destroy a container

import { getSandbox } from "@cloudflare/sandbox"
import { formatError } from "@jared/utils"
import { desc, eq, sql } from "drizzle-orm"
import { Hono } from "hono"
import * as dbSchema from "@/db/schema"
import { saveSession } from "@/lib/containers/sessions"
import { isAuthenticated } from "@/middlewares"
import type { BaseEnv } from "@/types"

const OPENCODE_PORT = 4096

/** Safely parse the sessionData JSON blob stored in D1. */
function parseSessionData(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

const router = new Hono<BaseEnv>()
  // --- Unauthenticated: container posts session data here ---
  .post("/sessions", async (c) => {
    const db = c.get("db")
    const body = (await c.req.json()) as {
      entityKey: string
      sessionData: string
    }

    if (!body.entityKey || !body.sessionData) {
      return c.json({ error: "entityKey and sessionData required" }, 400)
    }

    await saveSession(db, body.entityKey, body.sessionData)
    return c.json({ ok: true })
  })

  // --- All routes below require authentication ---
  .use(isAuthenticated())

  // Paginated list of agent sessions
  .get("/sessions", async (c) => {
    const db = c.get("db")
    const page = Math.max(1, Number(c.req.query("page")) || 1)
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 25))
    const offset = (page - 1) * limit

    const [sessions, countResult] = await Promise.all([
      db
        .select({
          entityKey: dbSchema.agentSessions.entityKey,
          sessionData: dbSchema.agentSessions.sessionData,
          createdAt: dbSchema.agentSessions.createdAt,
          updatedAt: dbSchema.agentSessions.updatedAt,
        })
        .from(dbSchema.agentSessions)
        .orderBy(desc(dbSchema.agentSessions.updatedAt))
        .limit(limit)
        .offset(offset),
      db.select({ count: sql<number>`count(*)` }).from(dbSchema.agentSessions),
    ])

    const total = countResult[0]?.count ?? 0

    const data = sessions.map((s) => {
      const parsed = parseSessionData(s.sessionData)
      const sessionList = (parsed.sessions ?? []) as Array<Record<string, unknown>>
      const messages = (parsed.messages ?? {}) as Record<string, unknown[]>
      const statuses = parsed.sessionStatus as Record<string, Record<string, string>> | null

      const totalCost = sessionList.reduce((sum, sess) => sum + (typeof sess.cost === "number" ? sess.cost : 0), 0)
      const totalMessages = Object.values(messages).reduce(
        (sum, msgs) => sum + (Array.isArray(msgs) ? msgs.length : 0),
        0,
      )
      const statusValues = statuses ? Object.values(statuses) : []
      const hasBusy = statusValues.some((st) => st.type === "busy")

      // Prefer the root session (no parentID) for the summary preview
      const rootSession = sessionList.find((sess) => !sess.parentID) ?? sessionList[0]

      return {
        entityKey: s.entityKey,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        // Summary fields for the list view (no raw sessionData blob)
        sessionCount: sessionList.length,
        messageCount: totalMessages,
        totalCost,
        status: hasBusy ? "busy" : statusValues.length > 0 ? "idle" : "unknown",
        // Root session metadata as a preview
        title: (rootSession?.title as string) ?? null,
        agent: (rootSession?.agent as string) ?? null,
        model: ((rootSession?.model as Record<string, string>)?.id as string) ?? null,
      }
    })

    return c.json({
      data,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    })
  })

  // Single session detail — returns parsed, structured data
  .get("/sessions/detail", async (c) => {
    const db = c.get("db")
    const entityKey = c.req.query("entityKey")
    if (!entityKey) {
      return c.json({ error: "entityKey query parameter required" }, 400)
    }

    const session = await db.query.agentSessions.findFirst({
      where: eq(dbSchema.agentSessions.entityKey, entityKey),
    })

    if (!session) {
      return c.json({ error: "Session not found" }, 404)
    }

    const parsed = parseSessionData(session.sessionData)

    return c.json({
      entityKey: session.entityKey,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      sessions: parsed.sessions ?? [],
      sessionStatus: parsed.sessionStatus ?? {},
      messages: parsed.messages ?? {},
      logs: parsed.logs ?? "",
    })
  })

  // Live container inspection
  .get("/:entityKey/debug", async (c) => {
    const entityKey = decodeURIComponent(c.req.param("entityKey"))
    const sandbox = getSandbox(c.env.Sandbox, entityKey, { normalizeId: true })

    try {
      const [logResult, sessionResult, sessionList, processCheck] = await Promise.all([
        sandbox.exec("cat /tmp/opencode.log 2>/dev/null | tail -100", { cwd: "/workspace" }),
        sandbox.exec(`curl -sf http://localhost:${OPENCODE_PORT}/session/status 2>/dev/null`, { cwd: "/workspace" }),
        sandbox.exec(`curl -sf http://localhost:${OPENCODE_PORT}/session 2>/dev/null`, { cwd: "/workspace" }),
        sandbox.exec("ps aux 2>/dev/null | grep -v '\\[' | grep -v 'PID' | tail -30", { cwd: "/workspace" }),
      ])

      // Fetch last 5 messages from each session
      let sessionMessages: Record<string, string> = {}
      try {
        const sessions = JSON.parse(sessionList.stdout || "[]") as Array<{ id: string }>
        const msgResults = await Promise.all(
          sessions.map(async (s) => {
            const res = await sandbox.exec(
              `curl -sf "http://localhost:${OPENCODE_PORT}/session/${s.id}/message?limit=5" 2>/dev/null`,
              { cwd: "/workspace" },
            )
            return { id: s.id, messages: res.stdout || "[]" }
          }),
        )
        sessionMessages = Object.fromEntries(msgResults.map((r) => [r.id, r.messages]))
      } catch {
        /* best effort */
      }

      // Check keepalive status
      const keepaliveCheck = await sandbox.exec(
        "pgrep -f 'keepalive.sh' > /dev/null 2>&1 && echo running || echo stopped",
        { cwd: "/workspace" },
      )

      // Save session data to D1 on every debug call (supplements keepalive)
      const db = c.get("db")
      if (sessionList.stdout && sessionResult.stdout) {
        try {
          const sessionData = JSON.stringify({
            sessionStatus: JSON.parse(sessionResult.stdout),
            sessions: JSON.parse(sessionList.stdout),
            logs: logResult.stdout || "",
            messages: Object.fromEntries(
              Object.entries(sessionMessages).map(([k, v]) => {
                try {
                  return [k, JSON.parse(v)]
                } catch {
                  return [k, []]
                }
              }),
            ),
          })
          await saveSession(db, entityKey, sessionData)
        } catch {
          /* best effort */
        }
      }

      return c.json({
        entityKey,
        opencodeLogs: logResult.stdout || logResult.stderr || "(empty)",
        sessionStatus: sessionResult.stdout || "(empty)",
        sessions: sessionList.stdout || "(empty)",
        sessionMessages,
        processes: processCheck.stdout || "(empty)",
        keepalive: keepaliveCheck.stdout?.trim() || "unknown",
      })
    } catch (err) {
      return c.json({ error: formatError(err) }, 500)
    }
  })

  // Clear all agent sessions from D1
  .delete("/sessions", async (c) => {
    const db = c.get("db")
    const result = await db.delete(dbSchema.agentSessions).returning({ entityKey: dbSchema.agentSessions.entityKey })
    return c.json({ ok: true, deleted: result.length })
  })

  // Delete a single agent session from D1
  .delete("/sessions/:entityKey", async (c) => {
    const db = c.get("db")
    const entityKey = decodeURIComponent(c.req.param("entityKey"))
    await db.delete(dbSchema.agentSessions).where(eq(dbSchema.agentSessions.entityKey, entityKey))
    return c.json({ ok: true, entityKey })
  })

  // Execute a command inside a running container
  .post("/:entityKey/exec", async (c) => {
    const entityKey = decodeURIComponent(c.req.param("entityKey"))
    const body = (await c.req.json()) as { command: string; cwd?: string }
    if (!body.command) return c.json({ error: "command required" }, 400)
    const sandbox = getSandbox(c.env.Sandbox, entityKey, { normalizeId: true })
    try {
      const result = await sandbox.exec(body.command, { cwd: body.cwd ?? "/workspace" })
      return c.json({ ok: true, stdout: result.stdout, stderr: result.stderr, success: result.success })
    } catch (err) {
      return c.json({ error: formatError(err) }, 500)
    }
  })

  // Force-destroy a container
  .post("/:entityKey/destroy", async (c) => {
    const entityKey = decodeURIComponent(c.req.param("entityKey"))
    const sandbox = getSandbox(c.env.Sandbox, entityKey, { normalizeId: true })
    try {
      await sandbox.destroy()
      return c.json({ ok: true, entityKey, action: "destroyed" })
    } catch (err) {
      return c.json({ error: formatError(err) }, 500)
    }
  })

export default router
