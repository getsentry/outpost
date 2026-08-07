// Container management routes.
//
// Groups all container-related operations under /api/containers:
//   POST /sessions         — unauthenticated, called from inside containers (Phase 1)
//   GET  /sessions         — authenticated, paginated list of agent sessions
//   GET  /sessions/detail  — authenticated, single session detail (syncs Flue DO or container)
//   DELETE /sessions       — authenticated, destroy sandboxes + clear D1 (or idle-only)
//   POST /:entityKey/prompt — authenticated, admit operator guidance into a run
//   POST /chat             — authenticated, start a dashboard chat run (no webhook)
//   GET  /chat/repos       — authenticated, repos the GitHub App can reach
//   GET  /:entityKey/debug — authenticated, live container inspection + D1 sync
//   POST /:entityKey/exec  — authenticated, execute command inside container
//   POST /:entityKey/destroy — authenticated, force-destroy a container
//
// Phase 2 (FLUE_NATIVE=1): session detail prefers Flue Durable Object history
// via @flue/sdk instead of curling an in-container harness.

import { getSandbox } from "@cloudflare/sandbox"
import { formatError, type Logger } from "@jared/utils"
import { and, desc, eq, isNotNull, sql } from "drizzle-orm"
import type { DrizzleD1Database } from "drizzle-orm/d1"
import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import * as dbSchema from "@/db/schema"
import {
  CHAT_STARTING_WINDOW_MS,
  createChatEntityKey,
  formatOperatorPrompt,
  isChatEntityKey,
  isValidRepoSlug,
  MAX_CHAT_REPO_LENGTH,
} from "@/lib/containers/chat-run"
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
  readFlueHistoryInProcess,
  readFlueUpdatesInProcess,
} from "@/lib/containers/flue-dispatch"
import { isFlueHistoryBusy } from "@/lib/containers/flue-session-adapt"
import { toAgentInstanceId } from "@/lib/containers/ids"
import { SANDBOX_OPTS } from "@/lib/containers/sandbox-opts"
import {
  countSessionMessages,
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
import { markEntityEventsCompleted } from "@/lib/github/dispatch"
import { formatChatPrompt } from "@/lib/github/prompt"
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
 * Shape the `/sessions/detail` response body from a parsed session blob. Shared
 * by the polling detail endpoint and the SSE stream so both emit an identical
 * payload the client can drop straight into the query cache.
 */
function formatSessionDetailPayload(
  session: { entityKey: string; createdAt: Date | string },
  parsed: Record<string, unknown>,
  updatedAt: Date | string,
  syncError: string | null,
) {
  const statusObservedAt = typeof updatedAt === "string" ? updatedAt : new Date(updatedAt).toISOString()
  const chatError = typeof parsed.chatError === "string" && parsed.chatError ? parsed.chatError : null
  return {
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
    chatError,
    chatAdmitted: parsed.chatAdmitted === true,
  }
}

/** Resolve after `ms`, or immediately when `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
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

type RepoAccess = { slug: string; installationToken: string; botLogin: string }

/**
 * Resolve the repo behind an entity key and mint an installation token for it.
 * Returns null when the key carries no repo or the App can't reach it — cheap
 * enough (one or two API calls) to run before responding to a request.
 */
async function resolveRepoAccess(env: BaseEnv["Bindings"], entityKey: string): Promise<RepoAccess | null> {
  const parsed = parseOwnerRepo(entityKey)
  if (!parsed) {
    console.warn("resolveRepoAccess.no_repo", { entityKey })
    return null
  }

  const app = createGitHubApp({
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET,
  })
  const [installationToken, botLogin] = await Promise.all([
    app.getRepoInstallationToken(parsed.owner, parsed.repo).catch(() => null),
    app.getBotLogin().catch(() => ""),
  ])
  // Null token → the App can't act on this repo (not installed / bad key /
  // rate-limited). getRepoInstallationToken already logged the GitHub status;
  // note the resulting access denial so the 503 it causes is traceable.
  if (!installationToken) {
    console.warn("resolveRepoAccess.no_token", { repo: parsed.slug })
    return null
  }
  return { slug: parsed.slug, installationToken, botLogin }
}

/** Clone the repo into the entity's sandbox and apply auth — same path webhook dispatch takes. */
async function prepEntitySandbox(
  env: BaseEnv["Bindings"],
  entityKey: string,
  access: RepoAccess,
  flueNative: boolean,
): Promise<void> {
  const { resolveFlueInternalToken } = await import("@/middlewares/flue-auth")
  await ensureSandboxReady(getSandbox(env.Sandbox, toAgentInstanceId(entityKey), SANDBOX_OPTS), {
    repo: access.slug,
    botLogin: access.botLogin,
    installationToken: access.installationToken,
    entityKey,
    openrouterApiKey: env.OPENROUTER_API_KEY,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    openaiApiKey: env.OPENAI_API_KEY,
    sentryDsn: env.SENTRY_DSN,
    sentryAuthToken: env.SENTRY_AUTH_TOKEN,
    appUrl: env.APP_URL,
    thinSandbox: flueNative,
    loreGatewayUrl: env.LORE_GATEWAY_URL,
    flueInternalToken: (await resolveFlueInternalToken(env)) ?? undefined,
  })
}

/** Admit a prompt into the entity's conversation, Phase 2 (DO) or Phase 1 (in-container). */
async function admitPrompt(
  env: BaseEnv["Bindings"],
  opts: { entityKey: string; prompt: string; flueNative: boolean; logger: Logger },
): Promise<{ conversationUrl?: string; submissionId?: string }> {
  if (opts.flueNative) {
    return dispatchToFlueAgent(env, { entityKey: opts.entityKey, prompt: opts.prompt, logger: opts.logger })
  }
  const submissionId = crypto.randomUUID()
  const { dispatchPrompt } = await import("@/lib/containers/dispatch")
  const sandbox = getSandbox(env.Sandbox, toAgentInstanceId(opts.entityKey), SANDBOX_OPTS)
  await dispatchPrompt(sandbox, opts.entityKey, opts.prompt, submissionId)
  return { submissionId }
}

/**
 * Record that a chat run's opening admit failed so the UI can stop saying
 * "starting up" and Clear Idle / stale demotion can treat it as finished.
 */
async function patchChatSessionMeta(
  db: DrizzleD1Database<typeof dbSchema>,
  entityKey: string,
  patch: { chatError?: string; chatAdmitted?: boolean },
): Promise<void> {
  const row = await db.query.agentSessions.findFirst({
    where: eq(dbSchema.agentSessions.entityKey, entityKey),
    columns: { sessionData: true },
  })
  if (!row) return
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(row.sessionData) as Record<string, unknown>
  } catch {
    parsed = {}
  }
  if (patch.chatError !== undefined) parsed.chatError = patch.chatError.slice(0, 500)
  if (patch.chatAdmitted !== undefined) {
    parsed.chatAdmitted = patch.chatAdmitted
    if (patch.chatAdmitted) delete parsed.chatError
  }
  let next = JSON.stringify(parsed)
  if (patch.chatError !== undefined) next = demoteBusyStatusesToIdle(next)
  await db
    .update(dbSchema.agentSessions)
    .set({ sessionData: next })
    .where(eq(dbSchema.agentSessions.entityKey, entityKey))
}

/**
 * Chat runs admit the opening turn asynchronously. Follow-ups that land before
 * that admit finishes race sandbox prep and can reorder the Flue conversation.
 */
async function chatStartGate(
  db: DrizzleD1Database<typeof dbSchema>,
  entityKey: string,
): Promise<{ blocked: true; status: 409 | 503; error: string } | { blocked: false }> {
  if (!isChatEntityKey(entityKey)) return { blocked: false }
  const session = await db.query.agentSessions.findFirst({
    where: eq(dbSchema.agentSessions.entityKey, entityKey),
    columns: { sessionData: true, createdAt: true },
  })
  if (!session) return { blocked: false }
  if (countSessionMessages(session.sessionData) > 0) return { blocked: false }

  let chatError: string | null = null
  let chatAdmitted = false
  try {
    const parsed = JSON.parse(session.sessionData) as { chatError?: unknown; chatAdmitted?: unknown }
    chatError = typeof parsed.chatError === "string" && parsed.chatError ? parsed.chatError : null
    chatAdmitted = parsed.chatAdmitted === true
  } catch {
    /* ignore */
  }
  if (chatAdmitted) return { blocked: false }
  if (chatError) {
    return { blocked: true, status: 503, error: `Chat failed to start: ${chatError}` }
  }

  const age = Date.now() - new Date(session.createdAt).getTime()
  if (age < CHAT_STARTING_WINDOW_MS) {
    return {
      blocked: true,
      status: 409,
      error: "Chat is still starting — wait for the first message to appear, then try again.",
    }
  }
  return { blocked: false }
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
        await Promise.all([
          db.delete(dbSchema.agentSessions).where(eq(dbSchema.agentSessions.entityKey, entityKey)),
          db.delete(dbSchema.webhookEvents).where(eq(dbSchema.webhookEvents.entityKey, entityKey)),
        ])
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

    return c.json(formatSessionDetailPayload(session, parsed, updatedAt, syncError))
  })

  // Live agent transcript over SSE. Pushes the same payload as /sessions/detail
  // on every durable stream change, so the dashboard stops polling while a run
  // is active. Reads happen in-process (same DO as dispatch), never the hairpin.
  .get("/sessions/stream", async (c) => {
    const db = c.get("db")
    const entityKey = c.req.query("entityKey")
    if (!entityKey) return c.json({ error: "entityKey query parameter required" }, 400)

    const flueNative = c.env.FLUE_NATIVE === "1" || c.env.FLUE_NATIVE === "true"
    // Non-Flue sessions have no durable stream to follow; the client polls instead.
    if (!flueNative) return c.json({ error: "streaming requires FLUE_NATIVE" }, 400)

    // Cap one connection's lifetime under Worker/edge limits; the browser's
    // EventSource transparently reconnects and we resend a fresh snapshot.
    const MAX_STREAM_MS = 4 * 60_000
    // Cut the long-poll wait this often so idle connections keep emitting.
    const HEARTBEAT_MS = 15_000

    return streamSSE(c, async (stream) => {
      const clientAbort = c.req.raw.signal
      const startedAt = Date.now()

      // Emit the current merged detail payload; return the stream head offset.
      const pushSnapshot = async (): Promise<{ offset: string | null; ok: boolean }> => {
        const session = await db.query.agentSessions.findFirst({
          where: eq(dbSchema.agentSessions.entityKey, entityKey),
        })
        if (!session) {
          await stream.writeSSE({ event: "gone", data: "session not found" })
          return { offset: null, ok: false }
        }

        let parsed = parseSessionData(session.sessionData)
        let updatedAt: Date | string = session.updatedAt
        let syncError: string | null = null
        let offset: string | null = null

        const hist = await readFlueHistoryInProcess(c.env, entityKey)
        if (hist.ok) {
          const blob = flueHistoryToSessionData(entityKey, hist.history)
          const mergedRaw = session.sessionData ? mergeSessionData(session.sessionData, blob) : blob
          try {
            await saveSession(db, entityKey, blob)
          } catch {
            /* best-effort persist */
          }
          parsed = parseSessionData(mergedRaw)
          updatedAt = new Date()
          offset = hist.offset
        } else if (!hist.notFound) {
          // Genuine absence keeps the D1 placeholder; only surface real errors.
          syncError = hist.error
        }

        await stream.writeSSE({
          event: "snapshot",
          data: JSON.stringify(formatSessionDetailPayload(session, parsed, updatedAt, syncError)),
        })
        return { offset, ok: true }
      }

      let seed = await pushSnapshot()
      let offset = seed.offset

      while (seed.ok && !clientAbort.aborted && Date.now() - startedAt < MAX_STREAM_MS) {
        if (!offset) {
          // No durable stream yet (history unavailable or not materialized). Back
          // off, then re-snapshot so a run that starts mid-connection lights up.
          await sleep(5_000, clientAbort)
          seed = await pushSnapshot()
          offset = seed.offset
          continue
        }

        // Heartbeat-bounded long-poll: abort the wait at HEARTBEAT_MS so idle
        // connections keep emitting and proxies don't drop them.
        const iterCtl = new AbortController()
        const onClientAbort = () => iterCtl.abort()
        clientAbort.addEventListener("abort", onClientAbort, { once: true })
        const hb = setTimeout(() => iterCtl.abort(), HEARTBEAT_MS)

        const upd = await readFlueUpdatesInProcess(c.env, entityKey, offset, iterCtl.signal)

        clearTimeout(hb)
        clientAbort.removeEventListener("abort", onClientAbort)
        if (clientAbort.aborted) break

        if (upd.ok && upd.hasNew) {
          const next = await pushSnapshot()
          offset = next.offset ?? upd.nextOffset
        } else if (upd.ok) {
          offset = upd.nextOffset
          await stream.writeSSE({ event: "ping", data: String(Date.now()) })
        } else {
          // Offset gone (DO recycled) or a transient error — reseed from history.
          if (!upd.gone) await sleep(2_000, clientAbort)
          seed = await pushSnapshot()
          offset = seed.offset
        }
      }
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

    const gate = await chatStartGate(db, entityKey)
    if (gate.blocked) return c.json({ error: gate.error }, gate.status)

    const flueNative = c.env.FLUE_NATIVE === "1" || c.env.FLUE_NATIVE === "true"
    const logger = c.get("logger").child({ ns: "containers.prompt", entity_key: entityKey })

    try {
      await saveInitialSession(db, entityKey)
    } catch {
      /* may already exist */
    }

    // Prep the sandbox (clone + skills + gh auth) BEFORE admitting. If this
    // silently failed we used to admit anyway, and the agent ran with no skills
    // and no GitHub auth — answering "no GitHub token available" instead of doing
    // the work (getsentry/cli#1371, spotlight#1343). Surface the failure so the
    // operator retries against a warm sandbox rather than talking to a crippled one.
    try {
      const access = await resolveRepoAccess(c.env, entityKey)
      if (!access) throw new Error("could not resolve repository access for this entity")
      await prepEntitySandbox(c.env, entityKey, access, flueNative)
    } catch (err) {
      logger.warn({ error: formatError(err) }, "operator prompt sandbox prep failed")
      return c.json({ error: "The agent's sandbox isn't ready yet (setup failed). Please try again in a moment." }, 503)
    }

    const { conversationUrl, submissionId } = await admitPrompt(c.env, {
      entityKey,
      prompt: formatOperatorPrompt(text),
      flueNative,
      logger,
    })
    return c.json({ ok: true, entityKey, conversationUrl, submissionId })
  })

  // Repos the GitHub App is installed on — the picker for starting a chat run.
  .get("/chat/repos", async (c) => {
    const app = createGitHubApp({
      appId: c.env.GITHUB_APP_ID,
      privateKey: c.env.GITHUB_APP_PRIVATE_KEY,
      webhookSecret: c.env.GITHUB_APP_WEBHOOK_SECRET,
    })
    try {
      return c.json({ repos: await app.listInstallationRepos() })
    } catch (err) {
      // Fall back to repos we've actually seen events from so the picker still
      // works when the installations API is unavailable.
      c.get("logger").warn({ ns: "containers.chat", error: formatError(err) }, "installation repo list failed")
      const rows = await c
        .get("db")
        .selectDistinct({ repo: dbSchema.webhookEvents.repo })
        .from(dbSchema.webhookEvents)
        .where(isNotNull(dbSchema.webhookEvents.repo))
      const repos = rows
        .map((r) => r.repo)
        .filter((r): r is string => !!r && isValidRepoSlug(r))
        .sort()
      return c.json({ repos })
    }
  })

  // Start a chat run: a conversation the operator opens from the dashboard
  // rather than one a GitHub webhook triggered.
  .post("/chat", async (c) => {
    const db = c.get("db")
    const body = (await c.req.json().catch(() => null)) as { repo?: string; text?: string } | null
    const repo = body?.repo?.trim()
    const text = body?.text?.trim()

    if (!repo || !isValidRepoSlug(repo)) {
      return c.json({ error: `repo must be an owner/name slug of at most ${MAX_CHAT_REPO_LENGTH} characters` }, 400)
    }
    if (!text) return c.json({ error: "text required" }, 400)
    if (text.length > 20_000) return c.json({ error: "text too long (max 20000)" }, 400)

    const entityKey = createChatEntityKey(repo)
    const flueNative = c.env.FLUE_NATIVE === "1" || c.env.FLUE_NATIVE === "true"
    const logger = c.get("logger").child({ ns: "containers.chat", entity_key: entityKey })

    // Check repo access before creating anything, so a repo the App can't reach
    // reports a real error instead of leaving an empty run behind.
    const access = await resolveRepoAccess(c.env, entityKey)
    if (!access) {
      return c.json({ error: `Can't access ${repo}. Check that the GitHub App is installed on it.` }, 400)
    }

    await saveInitialSession(db, entityKey)

    const user = c.get("user")
    const prompt = formatChatPrompt({
      entityKey,
      repo,
      botLogin: access.botLogin,
      operator: user?.name ?? user?.email ?? null,
      text,
    })

    // Cloning into a cold sandbox takes tens of seconds, so hand the run back
    // now and let the dashboard watch it start. Prep must finish before the
    // admit: dispatching first would race Jared's own clone check.
    c.executionCtx.waitUntil(
      (async () => {
        try {
          await prepEntitySandbox(c.env, entityKey, access, flueNative)
        } catch (err) {
          // Recoverable — Jared re-preps the sandbox on its first turn.
          logger.warn({ error: formatError(err) }, "chat run sandbox prep failed — continuing admit")
        }
        try {
          await admitPrompt(c.env, { entityKey, prompt, flueNative, logger })
          try {
            await patchChatSessionMeta(db, entityKey, { chatAdmitted: true })
          } catch {
            /* best effort — gate also clears once Flue history syncs */
          }
          logger.info({ repo }, "chat run started")
        } catch (err) {
          const message = formatError(err)
          logger.error({ error: message }, "chat run admit failed")
          try {
            await patchChatSessionMeta(db, entityKey, { chatError: message })
          } catch {
            /* best effort */
          }
        }
      })(),
    )

    return c.json({ ok: true, entityKey, repo })
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
      // Decide what to clear. A confidently-idle row (D1 actually saw it go idle)
      // is safe to drop. A "sync_unavailable" row is AMBIGUOUS: for Phase-2 runs
      // the D1 blob is a stale placeholder that never updates while the agent
      // works (the thin sandbox has no reporter), so a long-running *working*
      // container lands here too — and used to get deleted mid-task. Verify those
      // against the live Flue Durable Object (the source of truth) and keep
      // anything it reports as still busy, or anything we can't confirm is idle.
      const decided = await Promise.all(
        rows.map(async (row) => {
          const display = deriveDisplayStatus(row.sessionData, row.updatedAt)
          if (display === "idle" || display === "historical") {
            return { entityKey: row.entityKey, del: true }
          }
          if (display === "sync_unavailable") {
            const read = await readFlueHistoryInProcess(c.env, row.entityKey)
            // ok → trust the DO; 404 → nothing running; read error → keep (unsure).
            const liveIdle = read.ok ? !isFlueHistoryBusy(read.history) : read.notFound
            return { entityKey: row.entityKey, del: liveIdle }
          }
          // working / unknown → never delete.
          return { entityKey: row.entityKey, del: false }
        }),
      )
      const idleKeys = decided.filter((d) => d.del).map((d) => d.entityKey)
      if (idleKeys.length === 0) {
        return c.json({ ok: true, mode, deleted: 0, destroyed: 0 })
      }
      await Promise.all(
        idleKeys.flatMap((entityKey) => [
          db.delete(dbSchema.agentSessions).where(eq(dbSchema.agentSessions.entityKey, entityKey)),
          // Also drop stored webhook events so a later re-trigger starts with a
          // clean "Recent events" list instead of resurrecting the old one.
          db.delete(dbSchema.webhookEvents).where(eq(dbSchema.webhookEvents.entityKey, entityKey)),
        ]),
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
      // Clear both the session snapshots and the stored webhook events so a full
      // wipe leaves no D1 residue to resurface on the next trigger.
      await Promise.all([db.delete(dbSchema.agentSessions), db.delete(dbSchema.webhookEvents)])
    }

    return c.json({ ok: true, mode, deleted: rows.length, destroyed })
  })

  // Delete a single agent session from D1
  .delete("/sessions/:entityKey", async (c) => {
    const db = c.get("db")
    const entityKey = decodeURIComponent(c.req.param("entityKey"))
    await Promise.all([
      db.delete(dbSchema.agentSessions).where(eq(dbSchema.agentSessions.entityKey, entityKey)),
      db.delete(dbSchema.webhookEvents).where(eq(dbSchema.webhookEvents.entityKey, entityKey)),
    ])
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
    // Clean up session data + stored webhook events from D1 so a re-trigger
    // starts clean (past events used to resurface after a destroy).
    try {
      await Promise.all([
        db.delete(dbSchema.agentSessions).where(eq(dbSchema.agentSessions.entityKey, entityKey)),
        db.delete(dbSchema.webhookEvents).where(eq(dbSchema.webhookEvents.entityKey, entityKey)),
      ])
    } catch {
      /* best effort */
    }
    return c.json({ ok: true, entityKey, action: "destroyed" })
  })

export default router
