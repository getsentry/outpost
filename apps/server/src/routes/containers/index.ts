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
        sessionStatus: parsed.sessionStatus ?? null,
        sessions: parsed.sessions ?? null,
        logs: parsed.logs ?? null,
      }
    })

    return c.json({
      data,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    })
  })

  // Single session detail
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

    return c.json(session)
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
