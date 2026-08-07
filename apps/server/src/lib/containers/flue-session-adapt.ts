// Pure Flue → dashboard session-blob adapters (no Worker / dispatch imports).
// Used by saveSession (ingest choke point) and flueHistoryToSessionData.

import { toAgentInstanceId } from "./ids"

export const FLUE_AGENT = "jared"

type AnyRecord = Record<string, unknown>

/**
 * Normalize Flue history into the dashboard session blob shape.
 * Maps Flue `{ role, parts }` messages into the OpenCode-like
 * `{ info: { role }, parts }` shape the UI already renders.
 */
export function flueHistoryToSessionData(
  entityKey: string,
  history: Record<string, unknown> | null,
  opts?: { logs?: string },
): string {
  const sid = toAgentInstanceId(entityKey)
  const rawMessages = extractRawMessages(history)
  const settlements = extractSettlements(history)
  const messages = rawMessages
    .map((m, index) => normalizeFlueMessage(m, index))
    .filter((m): m is AnyRecord => m !== null)

  const status = deriveFlueBusyStatus(rawMessages, settlements) ? "busy" : "idle"
  const totalCost = messages.reduce((sum, m) => {
    const cost = (m.info as AnyRecord | undefined)?.cost
    return sum + (typeof cost === "number" ? cost : 0)
  }, 0)

  return JSON.stringify({
    sessions: [
      {
        id: sid,
        title: entityKey,
        agent: FLUE_AGENT,
        ...(totalCost > 0 ? { cost: totalCost } : {}),
      },
    ],
    sessionStatus: { [sid]: { type: status } },
    messages: { [sid]: messages },
    logs: opts?.logs ?? "",
    flue: true,
    flueHistory: history,
  })
}

/**
 * Normalize an already-assembled dashboard session blob that may contain raw
 * Flue messages (Phase 1 session-reporter / collectContainerData). Safe to call
 * on OpenCode blobs — returns them unchanged unless `flue: true`.
 */
export function normalizeFlueSessionBlob(entityKey: string, raw: string): string {
  let data: AnyRecord
  try {
    data = JSON.parse(raw) as AnyRecord
  } catch {
    return raw
  }
  if (!data.flue) return raw

  const sid = toAgentInstanceId(entityKey)
  const messagesIn = (data.messages ?? {}) as Record<string, unknown[]>
  // Prefer messages under the canonical conversation id; otherwise take the
  // first non-empty array (reporter may key by sid already).
  const rawList =
    (Array.isArray(messagesIn[sid]) && messagesIn[sid].length > 0
      ? messagesIn[sid]
      : Object.values(messagesIn).find((arr) => Array.isArray(arr) && arr.length > 0)) ?? []

  const historyFromBlob =
    data.flueHistory && typeof data.flueHistory === "object" ? (data.flueHistory as AnyRecord) : null
  const historyMessages = historyFromBlob ? extractRawMessages(historyFromBlob) : []
  const hasMessages = (rawList as unknown[]).length > 0 || historyMessages.length > 0

  // Empty placeholder (saveInitialSession): keep busy/idle from the blob, but
  // always key the session under the canonical conversation id.
  if (!hasMessages) {
    const statuses = (data.sessionStatus ?? {}) as Record<string, AnyRecord>
    const anyBusy = Object.values(statuses).some((st) => st?.type === "busy")
    return JSON.stringify({
      sessions: [{ id: sid, title: entityKey, agent: FLUE_AGENT }],
      sessionStatus: { [sid]: { type: anyBusy ? "busy" : "idle" } },
      messages: { [sid]: [] },
      logs: typeof data.logs === "string" ? data.logs : "",
      flue: true,
    })
  }

  const history: AnyRecord = historyFromBlob ?? {
    messages: rawList,
    settlements: Array.isArray(data.settlements) ? data.settlements : [],
  }

  // If flueHistory exists but has no messages, fall back to the blob's messages.
  if (
    (!Array.isArray(history.messages) || (history.messages as unknown[]).length === 0) &&
    (rawList as unknown[]).length > 0
  ) {
    history.messages = rawList
  }

  return flueHistoryToSessionData(entityKey, history, {
    logs: typeof data.logs === "string" ? data.logs : "",
  })
}

/** Adapt a Flue conversation message into the dashboard's SessionMessage shape. */
export function normalizeFlueMessage(raw: unknown, index: number): AnyRecord | null {
  if (!raw || typeof raw !== "object") {
    return { info: { id: `flue-${index}`, role: "unknown" }, parts: [] }
  }
  const m = raw as AnyRecord

  // Already OpenCode-shaped — still normalize tool parts if needed.
  if (m.info && typeof m.info === "object") {
    const info = m.info as AnyRecord
    const parts = Array.isArray(m.parts) ? (m.parts as unknown[]).map(normalizeFluePart) : []
    return { ...m, info, parts }
  }

  // Skip runtime plumbing that Flue marks hidden.
  if (m.display === "hidden") return null

  const role = typeof m.role === "string" ? m.role : "unknown"
  const id = typeof m.id === "string" ? m.id : `flue-${index}`
  const meta = m.metadata && typeof m.metadata === "object" ? (m.metadata as AnyRecord) : undefined
  const parts = Array.isArray(m.parts)
    ? (m.parts as unknown[]).map(normalizeFluePart)
    : typeof m.body === "string"
      ? [{ type: "text", text: m.body }]
      : typeof m.text === "string"
        ? [{ type: "text", text: m.text }]
        : []

  const cost = extractMessageCost(meta)
  const modelID =
    (typeof meta?.modelID === "string" && meta.modelID) ||
    (typeof meta?.model === "string" && meta.model) ||
    (typeof m.model === "string" && m.model) ||
    undefined
  const agent = (typeof meta?.agent === "string" && meta.agent) || (typeof m.agent === "string" && m.agent) || undefined

  return {
    info: {
      id,
      role,
      agent,
      modelID,
      cost,
      createdAt:
        typeof m.createdAt === "string" || typeof m.createdAt === "number"
          ? m.createdAt
          : typeof meta?.timestamp === "string" || typeof meta?.timestamp === "number"
            ? meta.timestamp
            : undefined,
    },
    parts,
  }
}

/** Map Flue parts into shapes the existing dashboard renderer understands. */
function normalizeFluePart(raw: unknown): AnyRecord {
  if (!raw || typeof raw !== "object") return { type: "unknown" }
  const part = raw as AnyRecord

  if (part.type === "dynamic-tool") {
    const toolName = typeof part.toolName === "string" ? part.toolName : "unknown"
    const flueState = typeof part.state === "string" ? part.state : "input-available"
    const status = flueState === "output-available" ? "completed" : flueState === "output-error" ? "error" : "running"
    return {
      type: "tool",
      tool: toolName,
      toolName,
      toolCallId: part.toolCallId,
      state: {
        status,
        input: part.input,
        output: flueState === "output-error" ? part.errorText : part.output,
      },
    }
  }

  // text / reasoning / file / data-* pass through (UI already handles text+reasoning).
  return part
}

function extractRawMessages(history: Record<string, unknown> | null): unknown[] {
  if (!history) return []
  if (Array.isArray(history.messages)) return history.messages
  if (Array.isArray(history.records)) return history.records
  if (Array.isArray(history.items)) return history.items
  return []
}

function extractSettlements(history: Record<string, unknown> | null): AnyRecord[] {
  if (!history || !Array.isArray(history.settlements)) return []
  return history.settlements as AnyRecord[]
}

/**
 * Authoritative live-busy signal for a raw Flue history snapshot: true when the
 * agent still has an open (unsettled) submission or a streaming/running part.
 *
 * Unlike the D1 `sessionData` heuristics (which go stale for Phase-2 runs — the
 * thin sandbox has no reporter, so a long-running *working* container looks
 * "stale busy"), this reads the Durable Object's own settlements, which is the
 * source of truth. Used to guard destructive actions (Clear Idle) from deleting
 * a container that is actually mid-task.
 */
export function isFlueHistoryBusy(history: Record<string, unknown> | null): boolean {
  return deriveFlueBusyStatus(extractRawMessages(history), extractSettlements(history))
}

/**
 * Busy when any submission is still open, or any part is still streaming /
 * waiting on a tool result.
 */
export function deriveFlueBusyStatus(rawMessages: unknown[], settlements: AnyRecord[]): boolean {
  const settled = new Set(
    settlements
      .map((s) => (typeof s.submissionId === "string" ? s.submissionId : null))
      .filter((id): id is string => !!id),
  )

  for (const raw of rawMessages) {
    if (!raw || typeof raw !== "object") continue
    const m = raw as AnyRecord
    const submissionId = typeof m.submissionId === "string" ? m.submissionId : undefined
    if (submissionId && !settled.has(submissionId) && (m.role === "user" || m.purpose === "user")) {
      return true
    }

    const parts = Array.isArray(m.parts) ? (m.parts as AnyRecord[]) : []
    for (const p of parts) {
      if (p.state === "streaming") return true
      if (p.type === "dynamic-tool" && p.state === "input-available") return true
      if (typeof p.state === "object" && p.state && (p.state as AnyRecord).status === "running") {
        return true
      }
    }
  }

  const submissionIds = new Set<string>()
  for (const raw of rawMessages) {
    if (!raw || typeof raw !== "object") continue
    const id = (raw as AnyRecord).submissionId
    if (typeof id === "string") submissionIds.add(id)
  }
  for (const id of submissionIds) {
    if (!settled.has(id)) return true
  }

  return false
}

function extractMessageCost(meta: AnyRecord | undefined): number | undefined {
  if (!meta) return undefined
  if (typeof meta.cost === "number") return meta.cost
  const usage = meta.usage
  if (usage && typeof usage === "object") {
    const cost = (usage as AnyRecord).cost
    if (typeof cost === "number") return cost
    if (cost && typeof cost === "object" && typeof (cost as AnyRecord).total === "number") {
      return (cost as AnyRecord).total as number
    }
  }
  return undefined
}
