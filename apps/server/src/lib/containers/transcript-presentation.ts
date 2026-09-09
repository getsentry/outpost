import { operatorText } from "./chat-run"

type MessagePart = { type?: string; text?: string; tool?: string; toolName?: string; state?: unknown }
export type TranscriptMessage = {
  info?: { role?: string; createdAt?: string }
  role?: string
  createdAt?: string
  parts?: MessagePart[]
}

/** Old Flue snapshots stored role/time at the top level; current ones use info. */
export function transcriptMessageRole(message: TranscriptMessage): string {
  return message.info?.role ?? message.role ?? "unknown"
}

export function transcriptMessageCreatedAt(message: TranscriptMessage): string | undefined {
  return message.info?.createdAt ?? message.createdAt
}

export type InboundMessage =
  | { source: "operator"; text: string }
  | {
      source: "github"
      label: string
      sender: string | null
      repo: string | null
      entityKey: string | null
      entityKind: "issue" | "pull" | null
      subject: string | null
      excerpt: string | null
      automated: boolean
      raw: string
    }
  | { source: "unknown"; text: string }

export type TranscriptGroup =
  | { kind: "inbound"; message: TranscriptMessage; inbound: InboundMessage }
  | { kind: "assistant"; message: TranscriptMessage; skipped: boolean }
  | {
      kind: "skipped-activity"
      count: number
      labels: string[]
      entries: Array<{ inbound: InboundMessage; user: TranscriptMessage; assistant: TranscriptMessage }>
    }

export type ActivityPreview = {
  source: "github" | "operator" | "unknown"
  state: "working" | "updated" | "skipped"
  summary: string | null
  eventLabel?: string
  sender?: string | null
}

function lineValue(text: string, name: string): string | null {
  const match = new RegExp(`^${name}:\\s*(.+)$`, "m").exec(text)
  return match?.[1]?.trim() || null
}

function shortText(text: string, max = 180): string {
  const compact = text.replace(/\s+/g, " ").trim()
  return compact.length > max ? `${compact.slice(0, max - 1).trimEnd()}…` : compact
}

function contextExcerpt(text: string): string | null {
  const section =
    /\n(?:Comment|Review):\n([\s\S]*?)(?=\n(?:Check suite|Workflow run):|\n\n(?:## PR discussion inbox|<!-- jared:execution-contract -->)|$)/.exec(
      text,
    )?.[1]
  if (!section) return null
  const prose = section
    .split("\n")
    .filter((line) => line.trim() && !line.trimStart().startsWith("-"))
    .join(" ")
  return prose ? shortText(prose) : null
}

/**
 * Converts an agent-facing inbound turn into a presentation-safe card. The raw
 * prompt remains attached to the source message for the technical disclosure.
 */
export function classifyInboundMessage(text: string): InboundMessage {
  if (text.startsWith("Operator guidance:") || text.startsWith("New operator chat")) {
    return { source: "operator", text: operatorText(text) }
  }

  const encodedEnvelope = /<!-- jared:transcript-v1=([^\s]+) -->/.exec(text)?.[1]
  if (encodedEnvelope) {
    try {
      const value = JSON.parse(decodeURIComponent(encodedEnvelope)) as Record<string, unknown>
      if (value.v === 1 && value.source === "github" && typeof value.label === "string") {
        const sender = typeof value.sender === "string" ? value.sender : null
        return {
          source: "github",
          label: value.label,
          sender,
          repo: typeof value.repo === "string" ? value.repo : null,
          entityKey: typeof value.entityKey === "string" ? value.entityKey : null,
          entityKind: value.entityKind === "issue" || value.entityKind === "pull" ? value.entityKind : null,
          subject: typeof value.subject === "string" ? value.subject : null,
          excerpt: typeof value.excerpt === "string" ? value.excerpt : null,
          automated: sender?.endsWith("[bot]") ?? false,
          raw: text,
        }
      }
    } catch {
      // Fall through to the legacy prompt parser below.
    }
  }

  const event = /^New webhook event:\s*([^\n<]+)(?:\s*<!--[^\n]*-->)?/m.exec(text)?.[1]?.trim()
  if (!event) return { source: "unknown", text }

  const sender = lineValue(text, "Sender")
  const subject = /^(?:PR|Issue) #\d+:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? null
  return {
    source: "github",
    label: event,
    sender,
    repo: lineValue(text, "Repository"),
    entityKey: lineValue(text, "Entity"),
    entityKind: /^PR #\d+:/m.test(text) ? "pull" : /^Issue #\d+:/m.test(text) ? "issue" : null,
    subject,
    excerpt: contextExcerpt(text),
    automated: sender?.endsWith("[bot]") ?? false,
    raw: text,
  }
}

export function assistantVisibleText(message: TranscriptMessage): string {
  return (message.parts ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text?.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim()
}

export function isSkippedAssistantMessage(message: TranscriptMessage): boolean {
  return /(?:^|\n)SKIPPED(?::|\b)/.test(assistantVisibleText(message))
}

/** Group consecutive, automated no-action exchanges without hiding human turns. */
export function groupTranscriptMessages(messages: TranscriptMessage[]): TranscriptGroup[] {
  const groups: TranscriptGroup[] = []
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (transcriptMessageRole(message) !== "user") {
      if (transcriptMessageRole(message) === "assistant") {
        groups.push({ kind: "assistant", message, skipped: isSkippedAssistantMessage(message) })
      }
      continue
    }

    const inbound = classifyInboundMessage((message.parts ?? []).map((part) => part.text ?? "").join(""))
    const next = messages[index + 1]
    if (
      inbound.source === "github" &&
      inbound.automated &&
      next &&
      transcriptMessageRole(next) === "assistant" &&
      isSkippedAssistantMessage(next)
    ) {
      const entries = [{ inbound, user: message, assistant: next }]
      index += 1
      while (index + 2 < messages.length) {
        const candidateUser = messages[index + 1]
        const candidateAssistant = messages[index + 2]
        if (
          !candidateUser ||
          !candidateAssistant ||
          transcriptMessageRole(candidateUser) !== "user" ||
          transcriptMessageRole(candidateAssistant) !== "assistant"
        )
          break
        const candidateInbound = classifyInboundMessage(
          (candidateUser.parts ?? []).map((part) => part.text ?? "").join(""),
        )
        if (
          candidateInbound.source !== "github" ||
          !candidateInbound.automated ||
          !isSkippedAssistantMessage(candidateAssistant)
        )
          break
        entries.push({ inbound: candidateInbound, user: candidateUser, assistant: candidateAssistant })
        index += 2
      }
      groups.push({
        kind: "skipped-activity",
        count: entries.length,
        labels: [...new Set(entries.map((entry) => entry.inbound.label))],
        entries,
      })
      continue
    }

    groups.push({ kind: "inbound", message, inbound })
  }
  return groups
}

/** Small, non-reasoning preview for the agent-run list and live summary. */
export function summarizeRunActivity(messages: TranscriptMessage[], status: string): ActivityPreview {
  const chronological = [...messages].sort((a, b) => {
    const aCreatedAt = transcriptMessageCreatedAt(a)
    const bCreatedAt = transcriptMessageCreatedAt(b)
    const aTime = aCreatedAt ? new Date(aCreatedAt).getTime() : 0
    const bTime = bCreatedAt ? new Date(bCreatedAt).getTime() : 0
    return aTime - bTime
  })
  const inbound = [...chronological].reverse().find((message) => transcriptMessageRole(message) === "user")
  const input = inbound
    ? classifyInboundMessage((inbound.parts ?? []).map((part) => part.text ?? "").join(""))
    : { source: "unknown" as const, text: "" }
  const latestAssistant = [...chronological].reverse().find((message) => transcriptMessageRole(message) === "assistant")
  const answer = latestAssistant ? assistantVisibleText(latestAssistant) : ""
  const working = status === "working" || status === "busy"
  const inputSummary =
    input.source === "operator"
      ? shortText(input.text)
      : input.source === "github"
        ? (input.excerpt ?? input.subject)
        : shortText(input.text)

  return {
    source: input.source,
    state: working ? "working" : latestAssistant && isSkippedAssistantMessage(latestAssistant) ? "skipped" : "updated",
    summary: working
      ? (inputSummary ?? (answer ? shortText(answer) : null))
      : answer
        ? shortText(answer)
        : inputSummary,
    ...(input.source === "github" ? { eventLabel: input.label, sender: input.sender } : {}),
  }
}
