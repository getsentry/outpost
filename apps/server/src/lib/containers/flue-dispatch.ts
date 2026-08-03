// Phase 2: dispatch prompts to the Jared Flue Durable Object.
//
// Prefer in-process `dispatch()` (no public HTTP hairpin, no rate-limit key).
// HTTP via @flue/sdk remains available for external callers / dashboard history.
//
// Jared is imported lazily so Node/vitest modules that only need helpers
// (jaredConversationUrl, flueHistoryToSessionData) do not load cloudflare:workers.

import { createFlueClient } from "@flue/sdk"
import type { Logger } from "@jared/utils"
import type { BaseEnvBindings } from "@/types/env/base"
import { AGENT } from "./dispatch"
import { toAgentInstanceId } from "./ids"

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
 */
export async function fetchFlueHistory(
  env: Env,
  entityKey: string,
): Promise<Record<string, unknown> | null> {
  const appUrl = env.APP_URL
  if (!appUrl) return null

  const conversationUrl = jaredConversationUrl(appUrl, entityKey)
  const client = createFlueClient({ url: conversationUrl })

  try {
    const history = await client.history()
    return history as unknown as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Normalize Flue history into the dashboard session blob shape.
 * Maps Flue `{ role, parts }` messages into the OpenCode-like
 * `{ info: { role }, parts }` shape the UI already renders.
 */
export function flueHistoryToSessionData(
  entityKey: string,
  history: Record<string, unknown> | null,
): string {
  const sid = toAgentInstanceId(entityKey)
  const rawMessages =
    history && Array.isArray(history.messages)
      ? history.messages
      : history && Array.isArray(history.records)
        ? history.records
        : history && Array.isArray(history.items)
          ? history.items
          : []

  const messages = rawMessages.map((m, index) => normalizeFlueMessage(m, index))

  return JSON.stringify({
    sessions: [{ id: sid, title: entityKey, agent: AGENT }],
    sessionStatus: { [sid]: { type: "idle" } },
    messages: { [sid]: messages },
    logs: "",
    flue: true,
    flueHistory: history,
  })
}

/** Adapt a Flue conversation message into the dashboard's SessionMessage shape. */
function normalizeFlueMessage(raw: unknown, index: number): Record<string, unknown> {
  if (!raw || typeof raw !== "object") {
    return { info: { id: `flue-${index}`, role: "unknown" }, parts: [] }
  }
  const m = raw as Record<string, unknown>

  // Already OpenCode-shaped
  if (m.info && typeof m.info === "object") return m

  const role = typeof m.role === "string" ? m.role : "unknown"
  const id = typeof m.id === "string" ? m.id : `flue-${index}`
  const parts = Array.isArray(m.parts)
    ? m.parts
    : typeof m.body === "string"
      ? [{ type: "text", text: m.body }]
      : typeof m.text === "string"
        ? [{ type: "text", text: m.text }]
        : []

  return {
    info: {
      id,
      role,
      agent: typeof m.agent === "string" ? m.agent : undefined,
      modelID: typeof m.model === "string" ? m.model : undefined,
      createdAt: typeof m.createdAt === "string" || typeof m.createdAt === "number" ? m.createdAt : undefined,
    },
    parts,
  }
}
