// Phase 2: dispatch prompts to the Jared Flue Durable Object.
//
// Prefer in-process `dispatch()` (no public HTTP hairpin, no rate-limit key).
// HTTP via @flue/sdk remains available for dashboard history, authenticated
// with the shared internal token.

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

/**
 * Pull a materialized conversation history from the Flue agent for the dashboard.
 * Requires APP_URL and authenticates with the internal token against the locked-down
 * `/agents/jared` mount.
 */
export async function fetchFlueHistory(env: Env, entityKey: string): Promise<Record<string, unknown> | null> {
  const appUrl = env.APP_URL
  if (!appUrl) {
    console.warn("fetchFlueHistory: APP_URL unset — cannot sync Phase 2 history")
    return null
  }

  const token = await resolveFlueInternalToken(env)
  if (!token) {
    console.warn("fetchFlueHistory: no FLUE_INTERNAL_TOKEN/BETTER_AUTH_SECRET — cannot auth history pull")
    return null
  }

  const conversationUrl = jaredConversationUrl(appUrl, entityKey)
  const client = createFlueClient({ url: conversationUrl, token })

  try {
    const history = await client.history()
    return history as unknown as Record<string, unknown>
  } catch (err) {
    console.warn("fetchFlueHistory failed", err)
    return null
  }
}
