// Phase 2: dispatch prompts to the Jared Flue Durable Object.
//
// Both the write (`dispatch()`) and the read (history) go through the runtime
// IN-PROCESS: the agent's Durable Object is addressed via the ambient
// `cloudflare:workers` binding, so neither depends on APP_URL or rate limits.
//
// This matters: a Worker fetching its OWN public URL (the `APP_URL` hairpin)
// does not resolve to the same Durable Object that processed the webhook — it
// comes back 404 ("conversation not found") even though the conversation
// exists and is readable by any external client. Reading in-process through the
// mounted agent router hits the correct DO every time. The @flue/sdk HTTP
// hairpin is kept only as a defensive fallback.

import { createFlueClient } from "@flue/sdk"
import type { Logger } from "@jared/utils"
import { resolveFlueInternalToken } from "@/middlewares/flue-auth"
import type { BaseEnvBindings } from "@/types/env/base"
import { AGENT } from "./dispatch"
import { toAgentInstanceId } from "./ids"

/** Re-export adapt helpers used by routes / tests. */
export {
  deriveFlueBusyStatus,
  flueHistoryToSessionData,
  normalizeFlueMessage,
  normalizeFlueSessionBlob,
} from "./flue-session-adapt"

type Env = BaseEnvBindings["Bindings"]

/** Build the absolute conversation URL for a Jared agent instance. */
export function jaredConversationUrl(appUrl: string, entityKey: string): string {
  const base = appUrl.replace(/\/$/, "")
  const id = toAgentInstanceId(entityKey)
  return `${base}/agents/${AGENT}/${id}`
}

/**
 * Admit a user prompt into the Jared Flue agent Durable Object.
 * Uses in-process dispatch so we do not depend on APP_URL or rate limits.
 */
export async function dispatchToFlueAgent(
  env: Env,
  opts: {
    entityKey: string
    prompt: string
    logger?: Logger
  },
): Promise<{ conversationUrl: string; submissionId?: string }> {
  const id = toAgentInstanceId(opts.entityKey)
  const appUrl = env.APP_URL?.replace(/\/$/, "") ?? ""
  const conversationUrl = appUrl ? `${appUrl}/agents/${AGENT}/${id}` : `/agents/${AGENT}/${id}`

  opts.logger?.info({ entity_key: opts.entityKey, instance_id: id }, "flue.dispatch.send")

  const { dispatch } = await import("@flue/runtime")
  const { Jared } = await import("@/agents/jared.ts")

  const receipt = await dispatch(Jared, {
    id,
    message: { kind: "user", body: opts.prompt },
  })

  const submissionId =
    typeof receipt === "object" && receipt && "submissionId" in receipt
      ? String((receipt as { submissionId: string }).submissionId)
      : undefined

  opts.logger?.info({ entity_key: opts.entityKey, instance_id: id, submissionId }, "flue.dispatch.admitted")

  return { conversationUrl, submissionId }
}

export type FlueHistoryResult = { ok: true; history: Record<string, unknown> } | { ok: false; error: string }

/** Transient failures worth a quick retry — the DO/hairpin is briefly unreachable. */
export function isTransientHistoryError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  // 404 (conversation not materialized yet) and 401/403 (auth) are not transient
  // in a way a synchronous retry fixes — let the dashboard's auto-refresh cover
  // the "still starting" case instead of blocking the response here.
  return /timeout|timed out|network|fetch failed|econnreset|502|503|504|429/i.test(message)
}

/**
 * The dashboard history read hairpins to the Worker's own public URL, which can
 * briefly fail while the agent's Durable Object spins up or right after a deploy.
 * A couple of short retries keeps those hiccups from surfacing as "sync
 * unavailable" on an otherwise healthy run.
 */
async function withHistoryRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (i === attempts - 1 || !isTransientHistoryError(err)) break
      await new Promise((resolve) => setTimeout(resolve, 200 * (i + 1)))
    }
  }
  throw lastErr
}

/**
 * Minimal shape of the mounted Flue agent router we call in-process. It is the
 * same factory app.ts mounts at `/agents/jared`; a second instance is safe
 * because `createAgentRouter` is a pure factory with no side effects.
 */
type AgentRouter = { request: (input: string, init?: RequestInit, env?: unknown) => Promise<Response> }

let jaredRouterPromise: Promise<AgentRouter> | null = null

/** Lazily build (and memoize) an in-process Jared agent router. */
function getJaredAgentRouter(): Promise<AgentRouter> {
  jaredRouterPromise ??= (async () => {
    const [{ createAgentRouter }, { Jared }] = await Promise.all([
      import("@flue/runtime/routing"),
      import("@/agents/jared.ts"),
    ])
    return createAgentRouter(Jared) as unknown as AgentRouter
  })()
  return jaredRouterPromise
}

type InProcessRead = { ok: true; history: Record<string, unknown> } | { ok: false; notFound: boolean; error: string }

/**
 * Read materialized history straight from the agent's Durable Object, in-process.
 * The router registers `GET /:id`; addressing it here resolves the same DO that
 * `dispatch()` writes to (ambient binding), so it does not hit the public-URL
 * hairpin that returns a spurious 404.
 */
async function readFlueHistoryInProcess(env: Env, entityKey: string): Promise<InProcessRead> {
  const id = toAgentInstanceId(entityKey)
  try {
    const router = await getJaredAgentRouter()
    const res = await router.request(`/${encodeURIComponent(id)}?view=history`, undefined, env)
    if (res.ok) {
      const history = (await res.json()) as Record<string, unknown>
      return { ok: true, history }
    }
    const notFound = res.status === 404
    return {
      ok: false,
      notFound,
      error: notFound
        ? "Agent conversation not found (may never have started or was recycled)"
        : `Flue history read failed (${res.status})`,
    }
  } catch (err) {
    // Router unavailable for an unexpected reason (import/runtime) — let the
    // caller fall back to the HTTP hairpin rather than fail the whole read.
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, notFound: false, error: `In-process history read failed: ${message}` }
  }
}

/**
 * Pull a materialized conversation history from the Jared agent for the dashboard.
 *
 * Primary path is the in-process DO read. Only when the router is unavailable
 * for an unexpected reason do we fall back to the authenticated `/agents/jared`
 * HTTP hairpin; a clean in-process 404 is surfaced directly (the hairpin can do
 * no better for a conversation that genuinely does not exist).
 */
export async function fetchFlueHistoryResult(env: Env, entityKey: string): Promise<FlueHistoryResult> {
  const inProcess = await readFlueHistoryInProcess(env, entityKey)
  if (inProcess.ok) return { ok: true, history: inProcess.history }
  if (inProcess.notFound) return { ok: false, error: inProcess.error }

  const hairpin = await fetchFlueHistoryViaHairpin(env, entityKey)
  if (hairpin.ok) return hairpin
  return { ok: false, error: hairpin.error }
}

/**
 * Defensive fallback: pull history over the authenticated `/agents/jared` HTTP
 * mount using the internal token. Susceptible to the Worker self-hairpin 404,
 * so it is only used when the in-process router is unavailable.
 */
async function fetchFlueHistoryViaHairpin(env: Env, entityKey: string): Promise<FlueHistoryResult> {
  const appUrl = env.APP_URL
  if (!appUrl) {
    return { ok: false, error: "APP_URL unset — cannot sync Phase 2 history" }
  }

  const token = await resolveFlueInternalToken(env)
  if (!token) {
    return { ok: false, error: "No FLUE_INTERNAL_TOKEN/BETTER_AUTH_SECRET — cannot auth history pull" }
  }

  const conversationUrl = jaredConversationUrl(appUrl, entityKey)
  const client = createFlueClient({ url: conversationUrl, token })

  try {
    const history = await withHistoryRetry(() => client.history())
    return { ok: true, history: history as unknown as Record<string, unknown> }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn("fetchFlueHistory hairpin failed", { entityKey, conversationUrl, error: message })
    // Prefer a short operator-facing reason; keep the raw message for details.
    const hint = /404|not found/i.test(message)
      ? "Agent conversation not found (may never have started or was recycled)"
      : /401|403|unauthorized|forbidden/i.test(message)
        ? "History auth failed — check FLUE_INTERNAL_TOKEN"
        : /429|rate.?limit/i.test(message)
          ? "History pull rate-limited"
          : /timeout|timed out|network|fetch failed/i.test(message)
            ? "Could not reach Flue history (network/timeout)"
            : "Flue history sync failed"
    return { ok: false, error: `${hint}: ${message}` }
  }
}

/**
 * Pull Flue history, returning null on failure (list/background sync paths).
 */
export async function fetchFlueHistory(env: Env, entityKey: string): Promise<Record<string, unknown> | null> {
  const result = await fetchFlueHistoryResult(env, entityKey)
  return result.ok ? result.history : null
}
