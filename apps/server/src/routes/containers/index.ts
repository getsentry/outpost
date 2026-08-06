// Container management routes.
//
// Groups all container-related operations under /api/containers:
//   POST /sessions         — unauthenticated, called from inside containers (Phase 1)
//   GET  /sessions         — authenticated, paginated list of agent sessions
//   GET  /sessions/detail  — authenticated, single session detail (syncs Flue DO or container)
//   DELETE /sessions       — authenticated, destroy sandboxes + clear D1 (or idle-only)
//   GET  /:entityKey/debug — authenticated, live container inspection + D1 sync
//   POST /:entityKey/exec  — authenticated, execute command inside container
//   POST /:entityKey/destroy — authenticated, force-destroy a container
//
// Phase 2 (FLUE_NATIVE=1): session detail prefers Flue Durable Object history
// via @flue/sdk instead of curling an in-container harness.

import { getSandbox } from "@cloudflare/sandbox"
import { formatError } from "@jared/utils"
import { and, desc, eq, isNotNull, sql } from "drizzle-orm"
import type { DrizzleD1Database } from "drizzle-orm/d1"
import { Hono } from "hono"
import * as dbSchema from "@/db/schema"
import {
  applyGitHubAuth,
  ensureSandboxReady,
  FLUE_AGENT_MOUNT,
  FLUE_PORT,
  OPENCODE_PORT,
  saveInitialSession,
} from "@/lib/containers/dispatch"
import { parseOwnerRepo } from "@/lib/containers/do-prep"
import {
  dispatchToFlueAgent,
  fetchFlueHistory,
  fetchFlueHistoryResult,
  flueHistoryToSessionData,
} from "@/lib/containers/flue-dispatch"
import { toAgentInstanceId } from "@/lib/containers/ids"
import { SANDBOX_OPTS } from "@/lib/containers/sandbox-opts"
import {
  demoteBusyStatusesToIdle,
  deriveDisplayStatus,
  deriveOverallStatus,
  isStaleBusy,
  mergeSessionData,
  SANDBOX_RUNTIME_NOTE,
  saveSession,
  summarizeSession,
} from "@/lib/containers/sessions"
import { createGitHubApp } from "@/lib/github/app"
import { formatOperatorPrompt, markEntityEventsCompleted } from "@/lib/github/dispatch"
import { isAuthenticated } from "@/middlewares"
import { requireUserOrInternalToken } from "@/middlewares/flue-auth"
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
 * Collect session data from a Phase 1 in-container Flue (or legacy OpenCode) process.
 * Returns a stringified JSON blob ready for saveSession(), or null if collection fails.
 *
 * Phase 2 prefers fetchFlueHistory() against the Durable Object conversation URL.
 */
async function collectContainerData(
  sandbox: ReturnType<typeof getSandbox>,
  entityKey?: string,
): Promise<string | null> {
  // Prefer Flue ping + history (Phase 1 in-container).
  const fluePing = await sandbox.exec(`curl -sf --max-time 5 http://localhost:${FLUE_PORT}/api/ping 2>/dev/null`, {
    cwd: "/workspace",
  })
  if (fluePing.success) {
    const [logResult, histResult] = await Promise.all([
      sandbox.exec("tail -100 /tmp/flue.log 2>/dev/null || true", { cwd: "/workspace" }),
      sandbox.exec(
        `CONV=$(cat /tmp/dispatch-session-id 2>/dev/null || echo default); curl -sf --max-time 8 "http://localhost:${FLUE_PORT}${FLUE_AGENT_MOUNT}/$CONV?view=history" 2>/dev/null`,
        { cwd: "/workspace" },
      ),
    ])
    if (!histResult.stdout) return null
    try {
      const hist = JSON.parse(histResult.stdout) as Record<string, unknown>
      const sid =
        (
          await sandbox.exec("cat /tmp/dispatch-session-id 2>/dev/null || echo default", {
            cwd: "/workspace",
          })
        ).stdout?.trim() || "default"
      const key = entityKey ?? sid
      // Normalize into the OpenCode-like blob the dashboard renders.
      return flueHistoryToSessionData(key, hist, { logs: logResult.stdout || "" })
    } catch {
      return null
    }
  }

  // Legacy OpenCode fallback (pre-migration containers still running).
  const [logResult, sessionResult, sessionList] = await Promise.all([
    sandbox.exec("cat /tmp/opencode.log 2>/dev/null | tail -100", { cwd: "/workspace" }),
    sandbox.exec(`curl -sf --max-time 8 http://localhost:${OPENCODE_PORT}/session/status 2>/dev/null`, {
      cwd: "/workspace",
    }),
    sandbox.exec(`curl -sf --max-time 8 http://localhost:${OPENCODE_PORT}/session 2>/dev/null`, { cwd: "/workspace" }),
  ])

  if (!sessionList.stdout) return null

  const MAX_SESSIONS = 25
  const sessions = (unwrapArray(sessionList.stdout) as Array<{ id: string }>).slice(0, MAX_SESSIONS)

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

/**
 * Best-effort: rewrite stale busy placeholders to idle in D1 without bumping
 * updatedAt (age must stay accurate for historical classification).
 *
 * Re-reads the row before writing so a fresher ingest cannot be clobbered by a
 * demotion scheduled from a stale request snapshot.
 */
async function persistStaleBusyDemotion(db: DrizzleD1Database<typeof dbSchema>, entityKey: string): Promise<void> {
  const row = await db.query.agentSessions.findFirst({
    where: eq(dbSchema.agentSessions.entityKey, entityKey),
    columns: { sessionData: true, updatedAt: true },
  })
  if (!row || !isStaleBusy(row.sessionData, row.updatedAt)) return
  const demoted = demoteBusyStatusesToIdle(row.sessionData)
  if (demoted === row.sessionData) return
  await db
    .update(dbSchema.agentSessions)
    .set({ sessionData: demoted })
    .where(eq(dbSchema.agentSessions.entityKey, entityKey))
}

const router = new Hono<BaseEnv>()
  // --- Session ingest from containers: requires a per-entity scoped token ---
  .post("/sessions", async (c) => {
    const { FLUE_INTERNAL_HEADER, resolveFlueInternalToken } = await import("@/middlewares/flue-auth")
    const { verifySessionIngestToken } = await import("@/lib/containers/session-ingest-token")

    const db = c.get("db")
    const body = (await c.req.json()) as {
      entityKey: string
      sessionData: string
    }

    if (!body.entityKey || !body.sessionData) {
      return c.json({ error: "entityKey and sessionData required" }, 400)
    }

    const header = c.req.header(FLUE_INTERNAL_HEADER) ?? c.req.header("authorization")?.replace(/^Bearer\s+/i, "")
    const secret = await resolveFlueInternalToken(c.env)
    if (!secret || !header || !(await verifySessionIngestToken(secret, header, body.entityKey))) {
      return c.json({ error: "Unauthorized" }, 401)
    }

    await saveSession(db, body.entityKey, body.sessionData)
    return c.json({ ok: true })
  })

  // --- Maintenance routes: allow a logged-in user OR the Worker-internal token ---
  // These are placed before the blanket isAuthenticated() so operators/automation
  // can recycle a wedged container and inspect it without a browser session.
  //
  // Recycle: force-destroy a container so the next dispatch spawns a fresh one
  // (e.g. after a base-image bump — a deploy does not replace already-running
  // container instances). Keeps the D1 row unless ?purge=1.
  .post("/:entityKey/recycle", requireUserOrInternalToken, async (c) => {
    const entityKey = decodeURIComponent(c.req.param("entityKey"))
    const purge = c.req.query("purge") === "1"
    const db = c.get("db")
    let destroyed = true
    try {
      const sandbox = getSandbox(c.env.Sandbox, toAgentInstanceId(entityKey), SANDBOX_OPTS)
      await sandbox.destroy()
    } catch {
      destroyed = false
    }
    if (purge) {
      try {
        await db.delete(dbSchema.agentSessions).where(eq(dbSchema.agentSessions.entityKey, entityKey))
      } catch {
        /* best effort */
      }
    }
    return c.json({ ok: true, entityKey, destroyed, purged: purge })
  })

  // Inspect: run a FIXED read-only diagnostic inside the container (process list
  // + key log tails + flue ping) so we can see why a container is wedged without
  // SSH. No arbitrary command input — keeps the internal-token surface minimal.
  .get("/:entityKey/inspect", requireUserOrInternalToken, async (c) => {
    const entityKey = decodeURIComponent(c.req.param("entityKey"))
    const cmd =
      "echo '== ps =='; ps aux 2>/dev/null | grep -v '\\[' | tail -30; " +
      "echo '== flue.log =='; tail -40 /tmp/flue.log 2>/dev/null; " +
      "echo '== bootstrap.log =='; tail -40 /tmp/flue-bootstrap.log 2>/dev/null; " +
      "echo '== lore.log =='; tail -20 /tmp/lore.log 2>/dev/null; " +
      "echo '== ping =='; curl -sf --max-time 5 http://localhost:4096/api/ping 2>&1 || echo 'flue ping failed'"
    try {
      const sandbox = getSandbox(c.env.Sandbox, toAgentInstanceId(entityKey), SANDBOX_OPTS)
      const result = await sandbox.exec(cmd, { cwd: "/workspace" })
      return c.json({ ok: true, entityKey, success: result.success, stdout: result.stdout, stderr: result.stderr })
    } catch (err) {
      // Surface the SDK's structured startup error (context.error holds the real
      // reason, e.g. "container exited with unexpected exit code" vs "not
      // listening") — the top-level message is a generic "Container is starting".
      const detail =
        err && typeof err === "object" && "toJSON" in err && typeof (err as { toJSON: unknown }).toJSON === "function"
          ? (err as { toJSON: () => unknown }).toJSON()
          : undefined
      return c.json({ ok: false, entityKey, error: formatError(err), detail }, 500)
    }
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

    // Phase 2: list view has no session-reporter push — kick a background Flue
    // history pull for stale rows on this page so status/message counts catch up
    // without requiring the user to open detail first.
    const flueNative = c.env.FLUE_NATIVE === "1" || c.env.FLUE_NATIVE === "true"
    if (flueNative) {
      const staleKeys = sessions
        .filter((s) => Date.now() - new Date(s.updatedAt).getTime() > 15_000)
        .map((s) => s.entityKey)
        .slice(0, 5)
      if (staleKeys.length > 0) {
        c.executionCtx.waitUntil(
          (async () => {
            for (const entityKey of staleKeys) {
              try {
                const history = await fetchFlueHistory(c.env, entityKey)
                if (history) await saveSession(db, entityKey, flueHistoryToSessionData(entityKey, history))
              } catch {
                /* best effort */
              }
            }
          })(),
        )
      }
    }

    // Heal stale busy placeholders (saveInitialSession) so Clear Idle and future
    // loads see idle — preserve updatedAt via dedicated update.
    const demoteKeys = sessions.filter((s) => isStaleBusy(s.sessionData, s.updatedAt)).map((s) => s.entityKey)
    if (demoteKeys.length > 0) {
      c.executionCtx.waitUntil(
        (async () => {
          for (const row of sessions) {
            if (!demoteKeys.includes(row.entityKey)) continue
            try {
              await persistStaleBusyDemotion(db, row.entityKey)
            } catch {
              /* best effort */
            }
          }
        })(),
      )
    }

    const data = sessions.map((s) => {
      const parsed = parseSessionData(s.sessionData)
      const sessionList = (parsed.sessions ?? []) as Array<Record<string, unknown>>
      const messages = (parsed.messages ?? {}) as Record<string, unknown[]>

      const allMessages = Object.values(messages).flat() as Array<Record<string, unknown>>
      const totalMessages = allMessages.length

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

      const statusObservedAt = typeof s.updatedAt === "string" ? s.updatedAt : new Date(s.updatedAt).toISOString()

      return {
        entityKey: s.entityKey,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        statusObservedAt,
        sandboxHint: SANDBOX_RUNTIME_NOTE,
        // Summary fields for the list view (no raw sessionData blob)
        sessionCount: sessionList.length,
        messageCount: totalMessages,
        totalCost: totalCost > 0 ? totalCost : summary.cost,
        status: deriveDisplayStatus(parsed, s.updatedAt),
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

  // Single session detail — prefers live Flue DO history (Phase 2), falls back to D1.
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

    const flueNative = c.env.FLUE_NATIVE === "1" || c.env.FLUE_NATIVE === "true"
    let syncError: string | null = null
    let parsed = parseSessionData(session.sessionData)
    let updatedAt = session.updatedAt

    if (flueNative) {
      // Live-first: await Flue history so empty D1 placeholders do not win.
      const result = await fetchFlueHistoryResult(c.env, entityKey)
      if (result.ok) {
        const blob = flueHistoryToSessionData(entityKey, result.history)
        // saveSession merges with D1; respond with that same merge so we don't
        // drop prior sessions/messages that Flue no longer reports.
        const mergedRaw = session.sessionData ? mergeSessionData(session.sessionData, blob) : blob
        try {
          await saveSession(db, entityKey, blob)
        } catch {
          /* best effort persist */
        }
        parsed = parseSessionData(mergedRaw)
        updatedAt = new Date()
        if (deriveOverallStatus(parsed) === "idle") {
          const observedIdleAt = new Date()
          c.executionCtx.waitUntil(markEntityEventsCompleted(db, entityKey, { dispatchedBefore: observedIdleAt }))
        }
      } else {
        syncError = result.error
        // Stale busy + failed sync: show sync_unavailable and demote for Clear Idle.
        if (isStaleBusy(session.sessionData, session.updatedAt)) {
          c.executionCtx.waitUntil(
            persistStaleBusyDemotion(db, entityKey).catch(() => {
              /* best effort */
            }),
          )
        }
      }
    } else {
      const isStale = Date.now() - new Date(session.updatedAt).getTime() > 15_000
      if (isStale) {
        c.executionCtx.waitUntil(
          (async () => {
            try {
              const sandbox = getSandbox(c.env.Sandbox, toAgentInstanceId(entityKey), SANDBOX_OPTS)
              const freshData = await collectContainerData(sandbox, entityKey)
              if (freshData) {
                await saveSession(db, entityKey, freshData)
                if (deriveOverallStatus(freshData) === "idle") {
                  await markEntityEventsCompleted(db, entityKey, { dispatchedBefore: new Date() })
                }
              } else if (isStaleBusy(session.sessionData, session.updatedAt)) {
                await persistStaleBusyDemotion(db, entityKey)
              }
            } catch {
              if (isStaleBusy(session.sessionData, session.updatedAt)) {
                try {
                  await persistStaleBusyDemotion(db, entityKey)
                } catch {
                  /* leave snapshot */
                }
              }
            }
          })(),
        )
      } else if (isStaleBusy(session.sessionData, session.updatedAt)) {
        c.executionCtx.waitUntil(
          persistStaleBusyDemotion(db, entityKey).catch(() => {
            /* best effort */
          }),
        )
      }
    }

    const statusObservedAt = typeof updatedAt === "string" ? updatedAt : new Date(updatedAt).toISOString()

    return c.json({
      entityKey: session.entityKey,
      createdAt: session.createdAt,
      updatedAt,
      statusObservedAt,
      sandboxHint: SANDBOX_RUNTIME_NOTE,
      status: deriveDisplayStatus(parsed, updatedAt, { syncError }),
      sessions: parsed.sessions ?? [],
      sessionStatus: parsed.sessionStatus ?? {},
      messages: parsed.messages ?? {},
      logs: parsed.logs ?? "",
      syncError,
    })
  })

  // Operator chat: admit free-form guidance into the live Jared conversation.
  .post("/:entityKey/prompt", async (c) => {
    const entityKey = decodeURIComponent(c.req.param("entityKey"))
    const db = c.get("db")
    const body = (await c.req.json().catch(() => null)) as { text?: string } | null
    const text = body?.text?.trim()
    if (!text) return c.json({ error: "text required" }, 400)
    if (text.length > 20_000) return c.json({ error: "text too long (max 20000)" }, 400)

    const flueNative = c.env.FLUE_NATIVE === "1" || c.env.FLUE_NATIVE === "true"
    const logger = c.get("logger").child({ ns: "containers.prompt", entity_key: entityKey })

    try {
      await saveInitialSession(db, entityKey)
    } catch {
      /* may already exist */
    }

    const parsed = parseOwnerRepo(entityKey)
    const sandboxId = toAgentInstanceId(entityKey)
    const sandbox = getSandbox(c.env.Sandbox, sandboxId, SANDBOX_OPTS)

    // Prep thin sandbox when we can resolve a repo (same path as webhooks).
    if (parsed) {
      try {
        const app = createGitHubApp({
          appId: c.env.GITHUB_APP_ID,
          privateKey: c.env.GITHUB_APP_PRIVATE_KEY,
          webhookSecret: c.env.GITHUB_APP_WEBHOOK_SECRET,
        })
        const [installationToken, botLogin] = await Promise.all([
          app.getRepoInstallationToken(parsed.owner, parsed.repo),
          app.getBotLogin().catch(() => ""),
        ])
        if (installationToken) {
          const { resolveFlueInternalToken } = await import("@/middlewares/flue-auth")
          await ensureSandboxReady(sandbox, {
            repo: parsed.slug,
            botLogin,
            installationToken,
            entityKey,
            openrouterApiKey: c.env.OPENROUTER_API_KEY,
            anthropicApiKey: c.env.ANTHROPIC_API_KEY,
            openaiApiKey: c.env.OPENAI_API_KEY,
            sentryDsn: c.env.SENTRY_DSN,
            sentryAuthToken: c.env.SENTRY_AUTH_TOKEN,
            appUrl: c.env.APP_URL,
            thinSandbox: flueNative,
            loreGatewayUrl: c.env.LORE_GATEWAY_URL,
            flueInternalToken: (await resolveFlueInternalToken(c.env)) ?? undefined,
          })
        }
      } catch (err) {
        logger.warn({ error: formatError(err) }, "operator prompt sandbox prep failed — continuing admit")
      }
    }

    const prompt = formatOperatorPrompt(text)

    if (flueNative) {
      const { conversationUrl, submissionId } = await dispatchToFlueAgent(c.env, {
        entityKey,
        prompt,
        logger,
      })
      return c.json({ ok: true, entityKey, conversationUrl, submissionId })
    }

    // Phase 1 fallback: admit via in-container Flue.
    const eventId = crypto.randomUUID()
    const { dispatchPrompt } = await import("@/lib/containers/dispatch")
    await dispatchPrompt(sandbox, entityKey, prompt, eventId)
    return c.json({ ok: true, entityKey, submissionId: eventId })
  })

  // Live container / agent inspection — collects data and saves to D1
  .get("/:entityKey/debug", async (c) => {
    const entityKey = decodeURIComponent(c.req.param("entityKey"))
    const flueNative = c.env.FLUE_NATIVE === "1" || c.env.FLUE_NATIVE === "true"
    const db = c.get("db")

    try {
      if (flueNative) {
        const history = await fetchFlueHistory(c.env, entityKey)
        if (history) {
          try {
            await saveSession(db, entityKey, flueHistoryToSessionData(entityKey, history))
          } catch {
            /* best effort */
          }
        }
        return c.json({
          entityKey,
          harness: "flue-native",
          flueLogs: "(phase 2 — history from Durable Object)",
          opencodeLogs: "(n/a)",
          sessionStatus: history
            ? JSON.stringify(JSON.parse(flueHistoryToSessionData(entityKey, history)).sessionStatus ?? {})
            : "{}",
          sessions: history
            ? JSON.stringify(JSON.parse(flueHistoryToSessionData(entityKey, history)).sessions ?? [])
            : "[]",
          processes: "(phase 2 thin sandbox — use container exec for process list)",
          keepalive: "n/a",
          historyPresent: !!history,
        })
      }

      const sandbox = getSandbox(c.env.Sandbox, toAgentInstanceId(entityKey), SANDBOX_OPTS)

      const [processCheck, keepaliveCheck] = await Promise.all([
        sandbox.exec("ps aux 2>/dev/null | grep -v '\\[' | grep -v 'PID' | tail -30", { cwd: "/workspace" }),
        sandbox.exec("pgrep -f 'keepalive.sh' > /dev/null 2>&1 && echo running || echo stopped", { cwd: "/workspace" }),
      ])

      // Collect session data and save to D1
      const freshData = await collectContainerData(sandbox, entityKey)
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
        flueLogs: (parsed.logs as string) || "(empty)",
        opencodeLogs: (parsed.logs as string) || "(empty)",
        sessionStatus: JSON.stringify(parsed.sessionStatus ?? {}),
        sessions: JSON.stringify(parsed.sessions ?? []),
        processes: processCheck.stdout || "(empty)",
        keepalive: keepaliveCheck.stdout?.trim() || "unknown",
        harness: parsed.flue ? "flue" : "legacy",
      })
    } catch (err) {
      return c.json({ error: formatError(err) }, 500)
    }
  })

  // Clear agent sessions.
  //   ?mode=all  (default) — destroy every sandbox, then delete all D1 rows
  //   ?mode=idle           — delete non-working rows (idle / historical / stale busy); no destroy
  .delete("/sessions", async (c) => {
    const db = c.get("db")
    const mode = c.req.query("mode") === "idle" ? "idle" : "all"

    const rows = await db
      .select({
        entityKey: dbSchema.agentSessions.entityKey,
        sessionData: dbSchema.agentSessions.sessionData,
        updatedAt: dbSchema.agentSessions.updatedAt,
      })
      .from(dbSchema.agentSessions)

    if (mode === "idle") {
      // Clear anything that is not actively working: idle/historical display, or
      // stale busy placeholders that never finished syncing.
      const idleKeys = rows
        .filter((row) => {
          const display = deriveDisplayStatus(row.sessionData, row.updatedAt)
          return (
            display === "idle" ||
            display === "historical" ||
            display === "sync_unavailable" ||
            isStaleBusy(row.sessionData, row.updatedAt)
          )
        })
        .map((row) => row.entityKey)
      if (idleKeys.length === 0) {
        return c.json({ ok: true, mode, deleted: 0, destroyed: 0 })
      }
      await Promise.all(
        idleKeys.map((entityKey) =>
          db.delete(dbSchema.agentSessions).where(eq(dbSchema.agentSessions.entityKey, entityKey)),
        ),
      )
      return c.json({ ok: true, mode, deleted: idleKeys.length, destroyed: 0 })
    }

    // Destroy sandboxes first so a dead container can't re-report into D1.
    const destroyResults = await Promise.allSettled(
      rows.map(async (row) => {
        const sandbox = getSandbox(c.env.Sandbox, toAgentInstanceId(row.entityKey), SANDBOX_OPTS)
        await sandbox.destroy()
      }),
    )
    const destroyed = destroyResults.filter((r) => r.status === "fulfilled").length

    if (rows.length > 0) {
      await db.delete(dbSchema.agentSessions)
    }

    return c.json({ ok: true, mode, deleted: rows.length, destroyed })
  })

  // Delete a single agent session from D1
  .delete("/sessions/:entityKey", async (c) => {
    const db = c.get("db")
    const entityKey = decodeURIComponent(c.req.param("entityKey"))
    await db.delete(dbSchema.agentSessions).where(eq(dbSchema.agentSessions.entityKey, entityKey))
    return c.json({ ok: true, entityKey })
  })

  // Re-mint and re-apply a fresh GitHub installation token inside the container.
  // Installation tokens expire after ~1h, which blocks the agent from pushing on
  // long/resumed runs. The container (or a user) can call this to recover without
  // waiting for the next event delivery.
  .post("/:entityKey/refresh-token", async (c) => {
    const entityKey = decodeURIComponent(c.req.param("entityKey"))
    const db = c.get("db")

    // Find the most recent event for this entity that carried both an
    // installation id and a repo — that's what we need to mint a scoped token.
    const event = await db.query.webhookEvents.findFirst({
      where: and(eq(dbSchema.webhookEvents.entityKey, entityKey), isNotNull(dbSchema.webhookEvents.installationId)),
      orderBy: desc(dbSchema.webhookEvents.createdAt),
    })

    if (!event?.installationId) {
      return c.json({ error: "No GitHub installation found for this container" }, 404)
    }

    try {
      const app = createGitHubApp({
        appId: c.env.GITHUB_APP_ID,
        privateKey: c.env.GITHUB_APP_PRIVATE_KEY,
        webhookSecret: c.env.GITHUB_APP_WEBHOOK_SECRET,
      })
      const octokit = app.getInstallationOctokit(event.installationId)
      const auth = (await octokit.auth({ type: "installation" })) as { token: string }

      const sandbox = getSandbox(c.env.Sandbox, toAgentInstanceId(entityKey), SANDBOX_OPTS)
      await applyGitHubAuth(sandbox, { repo: event.repo, installationToken: auth.token })

      return c.json({ ok: true, entityKey, repo: event.repo })
    } catch (err) {
      return c.json({ error: formatError(err) }, 500)
    }
  })

  // Execute a command inside a running container
  .post("/:entityKey/exec", async (c) => {
    const entityKey = decodeURIComponent(c.req.param("entityKey"))
    const body = (await c.req.json()) as { command: string; cwd?: string }
    if (!body.command) return c.json({ error: "command required" }, 400)
    const sandbox = getSandbox(c.env.Sandbox, toAgentInstanceId(entityKey), SANDBOX_OPTS)
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
    const sandbox = getSandbox(c.env.Sandbox, toAgentInstanceId(entityKey), SANDBOX_OPTS)
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
