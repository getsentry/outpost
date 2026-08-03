// Phase 2: dispatch prompts to the Jared Flue Durable Object.
//
// The Worker admits messages into the agent conversation via Flue's HTTP
// surface (createAgentRouter mount) or @flue/sdk. The container is only a
// thin Linux sandbox attached by the agent via useSandbox(cloudflareSandbox).

import { createFlueClient } from "@flue/sdk"
import type { Logger } from "@jared/utils"
import type { BaseEnvBindings } from "@/types/env/base"
import { AGENT } from "./dispatch"

type Env = BaseEnvBindings["Bindings"]

/** Build the absolute conversation URL for a Jared agent instance. */
export function jaredConversationUrl(appUrl: string, entityKey: string): string {
  const base = appUrl.replace(/\/$/, "")
  const id = entityKey.replace(/[^a-zA-Z0-9_-]/g, "-")
  return `${base}/agents/${AGENT}/${id}`
}

/**
 * Admit a user prompt into the Jared Flue agent Durable Object.
 * Returns once the message is accepted (202) — does not wait for settlement.
 */
export async function dispatchToFlueAgent(
  env: Env,
  opts: {
    entityKey: string
    prompt: string
    logger?: Logger
  },
): Promise<{ conversationUrl: string; submissionId?: string }> {
  const appUrl = env.APP_URL
  if (!appUrl) {
    throw new Error("APP_URL is required to dispatch to the Flue agent")
  }

  const conversationUrl = jaredConversationUrl(appUrl, opts.entityKey)
  const client = createFlueClient({ url: conversationUrl })

  opts.logger?.info({ entity_key: opts.entityKey, conversationUrl }, "flue.dispatch.send")

  const admission = await client.send({
    message: { kind: "user", body: opts.prompt },
  })

  opts.logger?.info(
    {
      entity_key: opts.entityKey,
      submissionId: (admission as { submissionId?: string }).submissionId,
    },
    "flue.dispatch.admitted",
  )

  return {
    conversationUrl,
    submissionId: (admission as { submissionId?: string }).submissionId,
  }
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
 */
export function flueHistoryToSessionData(
  entityKey: string,
  history: Record<string, unknown> | null,
): string {
  const sid = entityKey.replace(/[^a-zA-Z0-9_-]/g, "-")
  const messages =
    history && Array.isArray(history.messages)
      ? history.messages
      : history && Array.isArray(history.records)
        ? history.records
        : history && Array.isArray(history.items)
          ? history.items
          : []

  return JSON.stringify({
    sessions: [{ id: sid, title: entityKey, agent: AGENT }],
    sessionStatus: { [sid]: { type: "idle" } },
    messages: { [sid]: messages },
    logs: "",
    flue: true,
    flueHistory: history,
  })
}
