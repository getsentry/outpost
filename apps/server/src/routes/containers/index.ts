// Container management routes.
//
// Groups all container-related operations under /api/containers:
//   POST /sessions         — unauthenticated, called from inside containers
//   GET  /sessions         — authenticated, paginated list of agent sessions
//   GET  /sessions/detail  — authenticated, single session detail (auto-syncs from container)
//   GET  /:entityKey/debug — authenticated, live container inspection + D1 sync
//   POST /:entityKey/exec  — authenticated, execute command inside container
//   POST /:entityKey/destroy — authenticated, force-destroy a container

import { getSandbox } from "@cloudflare/sandbox"
import { formatError } from "@jared/utils"
import { desc, eq, sql } from "drizzle-orm"
import { Hono } from "hono"
import * as dbSchema from "@/db/schema"
import { OPENCODE_PORT } from "@/lib/containers/dispatch"
import { saveSession, summarizeSession } from "@/lib/containers/sessions"
import { isAuthenticated } from "@/middlewares"
import type { BaseEnv } from "@/types"

/**
 * Normalize an API response that may be a bare array or wrapped in { data: [...] }.
 * Returns the unwrapped array, preserving element shapes (works for sessions AND messages).
 */
function unwrapArray(raw: string): unknown[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) return parsed
    if (parsed && typeof parsed === "object" && "data" in parsed) {
      const d = (parsed as { data?: unknown }).data
      if (Array.isArray(d)) return d
    }
    return []
  } catch {
    return []
  }
}

/**
 * Collect session data from a running OpenCode container.
 * Returns a stringified JSON blob ready for saveSession(), or null if collection fails.
 */
async function collectContainerData(sandbox: ReturnType<typeof getSandbox>): Promise<string | null> {
  // All curls use --max-time so a busy container (agent using CPU) can't hang
  // the whole sync. Bounded so the request always returns promptly.
  const [logResult, sessionResult, sessionList] = await Promise.all([
    sandbox.exec("cat /tmp/opencode.log 2>/dev/null | tail -100", { cwd: "/workspace" }),
    sandbox.exec(`curl -sf --max-time 8 http://localhost:${OPENCODE_PORT}/session/status 2>/dev/null`, {
      cwd: "/workspace",
    }),
    sandbox.exec(`curl -sf --max-time 8 http://localhost:${OPENCODE_PORT}/session 2>/dev/null`, { cwd: "/workspace" }),
  ])

  if (!sessionList.stdout) return null

  // Cap the number of sessions we fetch messages for to bound the work.
  const MAX_SESSIONS = 25
  const sessions = (unwrapArray(sessionList.stdout) as Array<{ id: string }>).slice(0, MAX_SESSIONS)

  // Fetch messages for each session — messages are {info, parts} objects, NOT {id} objects
  let messages: Record<string, unknown[]> = {}
  try {
    const msgResults = await Promise.all(
      sessions.map(async (s) => {
        const res = await sandbox.exec(
          `curl -sf --max-time 12 "http://localhost:${OPENCODE_PORT}/session/${s.id}/message?limit=50" 2>/dev/null`,
          { cwd: "/workspace" },
        )
        try {
          return { id: s.id, messages: unwrapArray(res.stdout || "[]") }
        } catch {
          return { id: s.id, messages: [] }
        }
      }),
    )
    messages = Object.fromEntries(msgResults.map((r) => [r.id, r.messages]))
  } catch {
    /* best effort */
  }

  try {
    return JSON.stringify({
      sessionStatus: sessionResult.stdout ? JSON.parse(sessionResult.stdout) : {},
      sessions,
      logs: logResult.stdout || "",
      messages,
    })
  } catch {
    return null
  }
}

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

      const allMessages = Object.values(messages).flat() as Array<Record<string, unknown>>
      const totalMessages = allMessages.length
      const statusValues = statuses ? Object.values(statuses) : []
      const hasBusy = statusValues.some((st) => st.type === "busy")

      // Prefer the root session (no parentID) for the summary preview
      const rootSession = sessionList.find((sess) => !sess.parentID) ?? sessionList[0]

      // The session object may be a "pending" placeholder with no agent/model/cost;
      // in that case derive those fields from the messages instead. The container
      // stores the real conversation under a different key than the placeholder it
      // advertises, so fall back to every message when the id doesn't line up.
      const rootId = rootSession?.id as string | undefined
      const rootMessages =
        rootId && Array.isArray(messages[rootId]) ? (messages[rootId] as Array<Record<string, unknown>>) : allMessages
      const summary = summarizeSession(rootSession ?? {}, rootMessages)

      // Total cost across every session, falling back to message-derived cost.
      const totalCost = sessionList.reduce((sum, sess) => {
        const sid = sess.id as string | undefined
        const msgs = sid && Array.isArray(messages[sid]) ? (messages[sid] as Array<Record<string, unknown>>) : []
        return sum + summarizeSession(sess, msgs).cost
      }, 0)

      return {
        entityKey: s.entityKey,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        // Summary fields for the list view (no raw sessionData blob)
        sessionCount: sessionList.length,
        messageCount: totalMessages,
        totalCost: totalCost > 0 ? totalCost : summary.cost,
        status: hasBusy ? "busy" : statusValues.length > 0 ? "idle" : "unknown",
        // Root session metadata as a preview
        title: (rootSession?.title as string) ?? null,
        agent: summary.agent,
        model: summary.model,
      }
    })

    return c.json({
      data,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    })
  })

  // Single session detail — returns parsed, structured data.
  // Auto-syncs from the container when data is stale (>30s since last update).
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

    // Auto-sync: if data is stale, refresh from the running container IN THE
    // BACKGROUND so a busy container (agent using CPU) never blocks the UI.
    // The response always returns the latest D1 snapshot immediately; the next
    // poll picks up the freshly-synced data.
    const isStale = Date.now() - new Date(session.updatedAt).getTime() > 15_000
    if (isStale) {
      const sandbox = getSandbox(c.env.Sandbox, entityKey, { normalizeId: true })
      c.executionCtx.waitUntil(
        (async () => {
          try {
            const freshData = await collectContainerData(sandbox)
            if (freshData) await saveSession(db, entityKey, freshData)
          } catch {
            // Container might be dead/busy — leave the existing snapshot in place.
          }
        })(),
      )
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

  // Live container inspection — collects data from container and saves to D1
  .get("/:entityKey/debug", async (c) => {
    const entityKey = decodeURIComponent(c.req.param("entityKey"))
    const sandbox = getSandbox(c.env.Sandbox, entityKey, { normalizeId: true })

    try {
      const [processCheck, keepaliveCheck] = await Promise.all([
        sandbox.exec("ps aux 2>/dev/null | grep -v '\\[' | grep -v 'PID' | tail -30", { cwd: "/workspace" }),
        sandbox.exec("pgrep -f 'keepalive.sh' > /dev/null 2>&1 && echo running || echo stopped", { cwd: "/workspace" }),
      ])

      // Collect session data and save to D1
      const freshData = await collectContainerData(sandbox)
      const db = c.get("db")
      if (freshData) {
        try {
          await saveSession(db, entityKey, freshData)
        } catch {
          /* best effort */
        }
      }

      const parsed = freshData ? (JSON.parse(freshData) as Record<string, unknown>) : {}

      return c.json({
        entityKey,
        opencodeLogs: (parsed.logs as string) || "(empty)",
        sessionStatus: JSON.stringify(parsed.sessionStatus ?? {}),
        sessions: JSON.stringify(parsed.sessions ?? []),
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

  // Force-destroy a container and clean up session data
  .post("/:entityKey/destroy", async (c) => {
    const entityKey = decodeURIComponent(c.req.param("entityKey"))
    const db = c.get("db")
    const sandbox = getSandbox(c.env.Sandbox, entityKey, { normalizeId: true })
    try {
      await sandbox.destroy()
    } catch {
      // Container might already be dead — continue with D1 cleanup
    }
    // Clean up session data from D1
    try {
      await db.delete(dbSchema.agentSessions).where(eq(dbSchema.agentSessions.entityKey, entityKey))
    } catch {
      /* best effort */
    }
    return c.json({ ok: true, entityKey, action: "destroyed" })
  })

export default router
