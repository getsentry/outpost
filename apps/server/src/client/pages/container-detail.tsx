import {
  ArrowClockwise,
  ArrowLeft,
  CaretDown,
  CaretRight,
  ChatText,
  Check,
  Clock,
  Code,
  Copy,
  CurrencyDollar,
  ListBullets,
  PaperPlaneTilt,
  Robot,
  Stack,
  Terminal,
  Trash,
  TreeStructure,
  Warning,
  Wrench,
  X,
} from "@phosphor-icons/react"
import { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate, useParams, useSearchParams } from "react-router-dom"
import type { MessagePart, SessionDetailResponse, SessionInfo, SessionMessage } from "@/client/lib/api"
import { entityGitHubUrl, formatTime, formatTimeAgo, parseEntityKey, repoGitHubUrl } from "@/client/lib/format"
import { useDestroyContainer, useEvents, useSendPrompt, useSessionDetail } from "@/client/lib/queries"
import { GitHubLink } from "@/components/github-link"
import { StatusBadge } from "@/components/status-badge"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { chatEntityRepo, operatorText } from "@/lib/containers/chat-run"

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

function StatusDot({ status }: { status: string }) {
  const styles: Record<string, string> = {
    working: "bg-yellow-500 animate-pulse",
    busy: "bg-yellow-500 animate-pulse",
    idle: "bg-green-500",
    sync_unavailable: "bg-amber-500",
    historical: "bg-muted-foreground/50",
  }
  return <span className={`inline-block size-2 rounded-full ${styles[status] ?? "bg-gray-400"}`} />
}

function statusLabel(status: string): string {
  switch (status) {
    case "working":
    case "busy":
      return "Working"
    case "idle":
      return "Idle"
    case "sync_unavailable":
      return "Sync unavailable"
    case "historical":
      return "Historical"
    default:
      return "Offline"
  }
}

/**
 * Derive a session's agent/model/cost, falling back to the values carried on its
 * messages when the session object is a "pending" placeholder (which has no
 * agent/model and a zero cost). Mirrors the backend `summarizeSession` helper.
 */
function summarizeSession(
  session: SessionInfo | undefined,
  messages: SessionMessage[] = [],
): { agent: string | null; model: string | null; cost: number } {
  const infos = messages.map((m) => m.info).filter((info): info is NonNullable<SessionMessage["info"]> => !!info)

  let agent = session?.agent ?? null
  let model = session?.model?.id ?? null
  if (!agent || !model) {
    for (const info of infos) {
      if (!agent && info.agent) agent = info.agent
      if (!model && info.modelID) model = info.modelID
      if (agent && model) break
    }
  }

  const sessionCost = typeof session?.cost === "number" ? session.cost : 0
  const messageCost = infos.reduce((sum, info) => sum + (typeof info.cost === "number" ? info.cost : 0), 0)

  return { agent, model, cost: sessionCost > 0 ? sessionCost : messageCost }
}

/** Small inline button that copies text to the clipboard with a brief confirmation. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard may be unavailable (e.g. non-secure context) — fail silently.
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
      aria-label="Copy message"
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      {copied ? "Copied" : "Copy"}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Chat message components
// ---------------------------------------------------------------------------

function ChatMessage({ message }: { message: SessionMessage }) {
  const role = message.info?.role ?? "unknown"
  const parts = message.parts ?? []
  const time = message.info?.createdAt ? formatTime(message.info.createdAt) : null

  const isAssistant = role === "assistant"
  const isUser = role === "user"

  // Operator messages are framed for the agent before dispatch; show the words
  // the human actually typed.
  const displayText = (text: string) => (isUser ? operatorText(text) : text)

  // Render parts IN ORDER so the agent's narrative reads correctly: a line of
  // reasoning/text sits right next to the tool call it describes, instead of all
  // prose being hoisted above a wall of tool calls.
  const items = useMemo(() => toRenderItems(parts), [parts])

  // Concatenated visible prose for the copy button (text + reasoning only).
  const copyText = items
    .filter((it) => it.kind === "text")
    .map((it) => displayText(it.text))
    .join("\n\n")
    .trim()

  const hasVisibleContent = items.length > 0
  // Assistant messages may still be streaming (no parts yet). Show a working
  // indicator rather than hiding the message, so agent activity is visible.
  if (!hasVisibleContent && !isAssistant) return null

  return (
    <div className={`flex gap-3 px-4 py-3 ${isUser ? "bg-muted/30" : ""}`}>
      {/* Avatar */}
      <div
        className={`flex size-7 shrink-0 items-center justify-center rounded-full ${
          isAssistant
            ? "bg-blue-100 text-blue-600 dark:bg-blue-950 dark:text-blue-400"
            : isUser
              ? "bg-emerald-100 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400"
              : "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400"
        }`}
      >
        {isAssistant ? (
          <Robot className="size-3.5" />
        ) : isUser ? (
          <ChatText className="size-3.5" />
        ) : (
          <Terminal className="size-3.5" />
        )}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2">
          <span
            className={`text-xs font-semibold ${
              isAssistant
                ? "text-blue-600 dark:text-blue-400"
                : isUser
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-muted-foreground"
            }`}
          >
            {role === "assistant" ? "Assistant" : role === "user" ? "User" : role}
          </span>
          {time && <span className="text-[10px] tabular-nums text-muted-foreground/60">{time}</span>}
        </div>

        {/* Interleaved reasoning / text / tool calls, in the order they happened. */}
        <div className="space-y-1.5">
          {items.map((item, i) => {
            if (item.kind === "text") {
              return <TextPart key={i} text={displayText(item.text)} reasoning={item.reasoning} />
            }
            if (item.kind === "transient") {
              return <TransientGroup key={i} tools={item.tools} sample={item.sample} />
            }
            return (
              <ToolCallBlock
                key={i}
                toolName={item.toolName}
                status={item.status}
                args={item.args}
                result={item.result}
              />
            )
          })}
        </div>

        {isAssistant && !hasVisibleContent && (
          <div className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
            <ArrowClockwise className="size-3 animate-spin" />
            Working…
          </div>
        )}

        {copyText && (
          <div className="mt-2">
            <CopyButton text={copyText} />
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Message part normalization
// ---------------------------------------------------------------------------

type RenderItem =
  | { kind: "text"; reasoning: boolean; text: string }
  | {
      kind: "tool"
      toolName: string
      status?: string
      args?: Record<string, unknown>
      result?: unknown
    }
  // A run of consecutive sandbox-reset failures, collapsed into one quiet row.
  | { kind: "transient"; tools: string[]; sample: unknown }

// Internal stream markers that aren't worth showing.
const NOISE_PART_TYPES = new Set(["step-start", "step-finish", "snapshot", "patch"])

const isToolPart = (p: MessagePart) =>
  typeof p.type === "string" && (p.type.startsWith("tool") || p.type === "dynamic-tool")

/**
 * Sandbox tools run inside a Cloudflare Durable Object. When the Worker is
 * redeployed — or the platform recycles the object — in-flight tools fail with
 * these messages. They are infrastructure hiccups, not the agent getting it
 * wrong, so we surface them quietly instead of as loud red errors.
 */
const TRANSIENT_ERROR_RE =
  /Durable Object reset|Internal error in Durable Object storage|Network connection lost|object to be reset/i

function isTransientToolError(status: string | undefined, result: unknown): boolean {
  if (status !== "error") return false
  const text = typeof result === "string" ? result : result != null ? JSON.stringify(result) : ""
  return TRANSIENT_ERROR_RE.test(text)
}

/** Flatten a message's parts into ordered, render-ready items. */
function toRenderItems(parts: MessagePart[]): RenderItem[] {
  const items: RenderItem[] = []
  for (const part of parts) {
    if ((part.type === "text" || part.type === "reasoning") && part.text) {
      items.push({ kind: "text", reasoning: part.type === "reasoning", text: part.text })
      continue
    }
    if (isToolPart(part)) {
      // v1.17.0: `state` is an object { status, input, output }.
      // Flue dynamic-tool (unnormalized): `state` is a string like
      // "input-available" / "output-available" with top-level input/output.
      const stateObj = part.state && typeof part.state === "object" ? part.state : undefined
      const rawStatus = typeof part.state === "string" ? part.state : stateObj?.status
      const status =
        rawStatus === "input-available" || rawStatus === "streaming"
          ? "running"
          : rawStatus === "output-available"
            ? "completed"
            : rawStatus === "output-error"
              ? "error"
              : rawStatus
      const args =
        stateObj?.input ??
        (part.type === "tool-invocation" || part.type === "dynamic-tool" ? (part.input ?? part.args) : undefined)
      const result =
        stateObj?.output ??
        (part.type === "dynamic-tool"
          ? (part.output ?? part.errorText)
          : part.type !== "tool-invocation"
            ? part.result
            : undefined)
      const toolName = part.tool ?? part.toolName ?? "unknown"

      if (isTransientToolError(status, result)) {
        // Coalesce a run of resets into a single quiet row so 90 interrupted
        // bash calls don't drown out the actual work between them.
        const prev = items[items.length - 1]
        if (prev?.kind === "transient") {
          prev.tools.push(toolName)
          prev.sample = result
        } else {
          items.push({ kind: "transient", tools: [toolName], sample: result })
        }
        continue
      }

      items.push({ kind: "tool", toolName, status, args: args as Record<string, unknown> | undefined, result })
      continue
    }
    // Everything else (unknown / noise) is dropped from the transcript.
    if (!NOISE_PART_TYPES.has(part.type)) {
      // Keep a faint breadcrumb for genuinely unknown part types.
      items.push({ kind: "text", reasoning: true, text: `[${part.type}]` })
    }
  }
  return items
}

/** A single reasoning or answer block, individually expandable when long. */
function TextPart({ text, reasoning }: { text: string; reasoning: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const isLong = text.length > 1000
  const display = isLong && !expanded ? `${text.slice(0, 1000)}...` : text
  return (
    <div>
      {reasoning && (
        <div className="mb-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground/60">
          Reasoning
        </div>
      )}
      <pre
        className={`whitespace-pre-wrap break-words text-[13px] leading-relaxed ${
          reasoning ? "border-l-2 border-muted-foreground/30 pl-2 text-muted-foreground" : ""
        }`}
      >
        {display}
      </pre>
      {isLong && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="mt-1 text-[11px] font-medium text-primary hover:underline"
        >
          {expanded ? "Show less" : `Show all (${text.length.toLocaleString()} chars)`}
        </button>
      )}
    </div>
  )
}

/**
 * A collapsed run of sandbox-reset failures. These come from deploys or platform
 * hiccups recycling the tool's Durable Object mid-call — infrastructure, not the
 * agent — so we fold them into one muted, expandable line instead of a wall of
 * red errors that makes the run look broken.
 */
function TransientGroup({ tools, sample }: { tools: string[]; sample: unknown }) {
  const [open, setOpen] = useState(false)
  const count = tools.length
  const label =
    count === 1 ? `${tools[0]} interrupted — sandbox reset` : `${count} tool calls interrupted — sandbox reset`

  return (
    <div className="rounded-md border border-dashed border-border/40 bg-muted/10">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1 text-left text-[11px] text-muted-foreground/70 hover:bg-muted/20"
        title="The sandbox was reset (a deploy or platform hiccup), not an agent error. The agent retries these automatically."
      >
        <Warning className="size-3 shrink-0 text-muted-foreground/40" />
        <span className="italic">{label}</span>
        <span className="ml-auto">
          {open ? (
            <CaretDown className="size-3 text-muted-foreground/50" />
          ) : (
            <CaretRight className="size-3 text-muted-foreground/50" />
          )}
        </span>
      </button>
      {open && (
        <div className="space-y-1 border-t border-border/20 px-2.5 py-1.5">
          {count > 1 && <div className="font-mono text-[10px] text-muted-foreground/50">{tools.join(", ")}</div>}
          {sample != null && sample !== "" && (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all text-[10px] leading-relaxed text-muted-foreground/60">
              {typeof sample === "string" ? sample : JSON.stringify(sample, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

function ToolCallBlock({
  toolName,
  status,
  args,
  result,
}: {
  toolName: string
  status?: string
  args?: Record<string, unknown>
  result?: unknown
}) {
  const [open, setOpen] = useState(false)

  const statusColors: Record<string, string> = {
    completed: "text-green-600 dark:text-green-400",
    result: "text-green-600 dark:text-green-400",
    "output-available": "text-green-600 dark:text-green-400",
    running: "text-blue-600 dark:text-blue-400",
    call: "text-blue-600 dark:text-blue-400",
    "input-available": "text-blue-600 dark:text-blue-400",
    streaming: "text-blue-600 dark:text-blue-400",
    pending: "text-yellow-600 dark:text-yellow-400",
    partial_call: "text-yellow-600 dark:text-yellow-400",
    error: "text-red-600 dark:text-red-400",
    "output-error": "text-red-600 dark:text-red-400",
  }

  const hasArgs = !!args && Object.keys(args).length > 0
  const hasResult = result != null && result !== ""
  const hasContent = hasArgs || hasResult

  return (
    <div className="rounded-md border border-border/50 bg-background/80 dark:bg-muted/15">
      <button
        type="button"
        onClick={() => hasContent && setOpen(!open)}
        className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] ${hasContent ? "cursor-pointer hover:bg-muted/30" : "cursor-default"}`}
      >
        <Wrench className="size-3 shrink-0 text-muted-foreground/60" />
        <span className="font-mono font-medium">{toolName}</span>
        {status && <span className={`text-[10px] ${statusColors[status] ?? "text-muted-foreground"}`}>({status})</span>}
        {hasContent && (
          <span className="ml-auto">
            {open ? (
              <CaretDown className="size-3 text-muted-foreground" />
            ) : (
              <CaretRight className="size-3 text-muted-foreground" />
            )}
          </span>
        )}
      </button>
      {open && hasContent && (
        <div className="space-y-2 border-t border-border/30 px-2.5 py-2">
          {hasArgs && (
            <div>
              <div className="mb-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground/60">
                Input
              </div>
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all text-[10px] leading-relaxed text-muted-foreground">
                {JSON.stringify(args, null, 2)}
              </pre>
            </div>
          )}
          {hasResult && (
            <div>
              <div className="mb-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground/60">
                Output
              </div>
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all text-[10px] leading-relaxed text-muted-foreground">
                {typeof result === "string" ? result : JSON.stringify(result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Logs panel
// ---------------------------------------------------------------------------

function LogsPanel({ logs, onClose }: { logs: string; onClose: () => void }) {
  const [searchTerm, setSearchTerm] = useState("")

  const lines = useMemo(() => {
    if (!logs) return []
    return logs.split("\n").filter(Boolean)
  }, [logs])

  const filtered = useMemo(() => {
    if (!searchTerm) return lines
    const q = searchTerm.toLowerCase()
    return lines.filter((line) => line.toLowerCase().includes(q))
  }, [lines, searchTerm])

  return (
    <div className="border-t bg-background">
      <div className="flex items-center gap-2 border-b px-3 py-1.5">
        <Terminal className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">Logs</span>
        <input
          type="text"
          placeholder="Filter..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="ml-2 h-5 w-48 border border-input bg-background px-1.5 text-[10px] outline-none placeholder:text-muted-foreground focus:border-ring"
        />
        <span className="text-[10px] text-muted-foreground">
          {filtered.length}/{lines.length}
        </span>
        <button type="button" onClick={onClose} className="ml-auto text-muted-foreground hover:text-foreground">
          <X className="size-3.5" />
        </button>
      </div>
      <div className="max-h-52 overflow-auto p-1">
        {filtered.length > 0 ? (
          filtered.map((line, i) => {
            const isError = /error|fail|panic|fatal/i.test(line)
            const isWarn = /warn/i.test(line)
            return (
              <div
                key={i}
                className={`flex gap-2 px-2 py-px font-mono text-[10px] leading-relaxed ${
                  isError
                    ? "text-red-600 dark:text-red-400"
                    : isWarn
                      ? "text-yellow-600 dark:text-yellow-400"
                      : "text-muted-foreground"
                }`}
              >
                <span className="w-6 shrink-0 select-none text-right text-muted-foreground/30">{i + 1}</span>
                <span className="min-w-0 break-all">{line}</span>
              </div>
            )
          })
        ) : (
          <div className="py-4 text-center text-[10px] text-muted-foreground">{logs ? "No matches" : "No logs"}</div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Session sidebar item
// ---------------------------------------------------------------------------

function SessionSidebarItem({
  session,
  status,
  messageCount,
  agent,
  cost,
  isActive,
  onClick,
}: {
  session: SessionInfo
  status: string
  messageCount: number
  agent: string | null
  cost: number
  isActive: boolean
  onClick: () => void
}) {
  const isChild = !!session.parentID

  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left transition-colors ${
        isActive ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
      } ${isChild ? "ml-3" : ""}`}
    >
      <div className="mt-0.5">
        <StatusDot status={status} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          {isChild && <TreeStructure className="size-3 shrink-0 text-muted-foreground/50" />}
          <span className="truncate text-xs font-medium">{session.title ?? "Session"}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
          {agent && <span>{agent}</span>}
          <span>
            {messageCount} msg{messageCount !== 1 ? "s" : ""}
          </span>
          {cost > 0 && <span>${cost.toFixed(4)}</span>}
        </div>
      </div>
    </button>
  )
}

function ToolTimeline({ messages }: { messages: SessionMessage[] }) {
  const tools = useMemo(() => {
    const items: { name: string; status?: string }[] = []
    for (const msg of messages) {
      for (const part of msg.parts ?? []) {
        const isTool = typeof part.type === "string" && (part.type.startsWith("tool") || part.type === "dynamic-tool")
        if (!isTool) continue
        const stateObj = part.state && typeof part.state === "object" ? part.state : undefined
        const rawStatus = typeof part.state === "string" ? part.state : stateObj?.status
        const status =
          rawStatus === "input-available" || rawStatus === "streaming"
            ? "running"
            : rawStatus === "output-available"
              ? "done"
              : rawStatus === "output-error"
                ? "error"
                : rawStatus
        items.push({ name: part.tool ?? part.toolName ?? "unknown", status })
      }
    }
    return items.slice(-12)
  }, [messages])

  if (tools.length === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b px-4 py-2">
      <ListBullets className="size-3 text-muted-foreground" />
      <span className="mr-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Tools</span>
      {tools.map((t, i) => (
        <span
          key={`${t.name}-${i}`}
          className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] ${
            t.status === "running"
              ? "border-blue-300 text-blue-700 dark:border-blue-800 dark:text-blue-300"
              : t.status === "error"
                ? "border-red-300 text-red-700 dark:border-red-800 dark:text-red-300"
                : t.status === "done"
                  ? "border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-300"
                  : "border-border text-muted-foreground"
          }`}
        >
          <Wrench className="size-2.5" />
          {t.name}
          {t.status === "running" && <ArrowClockwise className="size-2.5 animate-spin" />}
        </span>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main detail page
// ---------------------------------------------------------------------------

export default function ContainerDetailPage() {
  const { entityKey: rawKey } = useParams<{ entityKey: string }>()
  const [searchParams] = useSearchParams()
  // Prefer the query-param form (/containers/detail?key=...) which is refresh-safe;
  // the path-param form (/containers/:entityKey) breaks on reload because the
  // encoded slash (%2F) in the entity key isn't matched by SPA asset fallback.
  const entityKey = searchParams.get("key") ?? (rawKey ? decodeURIComponent(rawKey) : "")
  const navigate = useNavigate()
  const { data, isLoading, isError, isFetching, refetch, dataUpdatedAt, streaming } = useSessionDetail(entityKey)
  const destroyContainer = useDestroyContainer()
  const sendPrompt = useSendPrompt(entityKey)
  // Chat runs are started from the dashboard, so no webhook ever targets them.
  const chatRepo = chatEntityRepo(entityKey)
  const entityEvents = useEvents({ entityKey, limit: 8 }, { enabled: !chatRepo })
  const [showLogs, setShowLogs] = useState(false)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [destroyOpen, setDestroyOpen] = useState(false)
  const [draft, setDraft] = useState("")
  const [optimistic, setOptimistic] = useState<SessionMessage[]>([])
  const chatEndRef = useRef<HTMLDivElement>(null)
  const chatScrollRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)

  const detail = (data ?? null) as SessionDetailResponse | null
  const sessions = detail?.sessions ?? []
  const sessionStatus = detail?.sessionStatus ?? {}
  const messages = detail?.messages ?? {}
  const logs = detail?.logs ?? ""
  const syncError = detail?.syncError
  const chatError = detail?.chatError
  const chatAdmitted = detail?.chatAdmitted === true

  const orderedSessions = useMemo(() => {
    const rootSessions = sessions.filter((s) => !s.parentID)
    const childSessionsByParent = new Map<string, SessionInfo[]>()
    for (const s of sessions) {
      if (s.parentID) {
        const arr = childSessionsByParent.get(s.parentID) ?? []
        arr.push(s)
        childSessionsByParent.set(s.parentID, arr)
      }
    }
    const ordered: SessionInfo[] = []
    for (const root of rootSessions) {
      ordered.push(root)
      const children = childSessionsByParent.get(root.id)
      if (children) ordered.push(...children)
    }
    const placed = new Set(ordered.map((s) => s.id))
    for (const s of sessions) {
      if (!placed.has(s.id)) ordered.push(s)
    }
    return ordered
  }, [sessions])

  const allMessages = useMemo(() => Object.values(messages).flat(), [messages])
  const effectiveSessionId = activeSessionId ?? orderedSessions[0]?.id ?? null
  const ownActiveMessages = effectiveSessionId ? (messages[effectiveSessionId] ?? []) : []
  const activeSession = orderedSessions.find((s) => s.id === effectiveSessionId)
  const serverMessages =
    ownActiveMessages.length === 0 && orderedSessions.length === 1 ? allMessages : ownActiveMessages
  const activeMessages = useMemo(() => [...serverMessages, ...optimistic], [serverMessages, optimistic])
  const messageCount = activeMessages.length
  const streamingPlaceholder = hasBusyPlaceholder(activeMessages)
  // Opening admit is async — block the composer until it lands so a follow-up
  // can't race sandbox prep and reorder the Flue conversation.
  const chatStarting = !!chatRepo && allMessages.length === 0 && !chatAdmitted && !chatError && optimistic.length === 0

  // Clear optimistic bubbles once the server transcript catches up. Both sides
  // are reduced to the operator's own words, so the agent framing the Worker
  // wraps a turn in can't cause a false miss.
  useEffect(() => {
    if (optimistic.length === 0) return
    const serverUserTexts = new Set(
      serverMessages
        .filter((m) => m.info?.role === "user")
        .map((m) => operatorText(m.parts?.map((p) => p.text ?? "").join("") ?? ""))
        .filter(Boolean),
    )
    setOptimistic((prev) => prev.filter((m) => !serverUserTexts.has(m.parts?.[0]?.text ?? "")))
  }, [serverMessages, optimistic.length])

  useEffect(() => {
    if (!stickToBottomRef.current) return
    if (messageCount === 0 && !streamingPlaceholder) return
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messageCount, streamingPlaceholder])

  const handleDestroy = () => {
    destroyContainer.mutate(entityKey, {
      onSuccess: () => {
        setDestroyOpen(false)
        navigate("/containers")
      },
      onError: () => setDestroyOpen(false),
    })
  }

  // Shared header actions (Refresh + Destroy) — rendered on both the normal
  // view and the "not found" view so they never disappear.
  const headerActions = (
    <div className="flex items-center gap-1">
      <Button variant="outline" size="xs" onClick={() => refetch()} disabled={isFetching}>
        <ArrowClockwise className={`size-3 ${isFetching ? "animate-spin" : ""}`} />
        Refresh
      </Button>
      <AlertDialog open={destroyOpen} onOpenChange={setDestroyOpen}>
        <AlertDialogTrigger asChild>
          <Button variant="outline" size="xs" disabled={destroyContainer.isPending}>
            <Trash className="size-3" />
            Destroy
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Destroy this agent run?</AlertDialogTitle>
            <AlertDialogDescription>
              This will force-stop the sandbox (if running) and delete the session data for{" "}
              <span className="font-mono font-medium">{entityKey}</span>. The agent will stop working. This action
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={destroyContainer.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={destroyContainer.isPending}
              onClick={(e) => {
                e.preventDefault()
                handleDestroy()
              }}
            >
              {destroyContainer.isPending ? (
                <>
                  <ArrowClockwise className="size-3 animate-spin" />
                  Destroying...
                </>
              ) : (
                "Destroy run"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <div className="flex gap-4">
          <Skeleton className="h-[500px] w-56" />
          <Skeleton className="h-[500px] flex-1" />
        </div>
      </div>
    )
  }

  if (isError || !detail) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-2">
          <Button variant="ghost" size="sm" onClick={() => navigate("/containers")}>
            <ArrowLeft className="size-3.5" />
            Back to agent runs
          </Button>
          {headerActions}
        </div>
        <div className="py-12 text-center text-sm text-muted-foreground">
          Agent run not found or still starting up. Try refreshing.
        </div>
      </div>
    )
  }

  const ghUrl = entityGitHubUrl(entityKey, "issues")
  const parsed = parseEntityKey(entityKey)
  const repoName = parsed ? `${parsed.owner}/${parsed.repo}` : chatRepo
  const activeSummary = summarizeSession(activeSession, serverMessages)

  // Summary. Cost is derived per-session with a message fallback so pending
  // placeholder sessions (no cost on the session object) still report a total.
  // When the messages live under a different key than the session id (pending
  // placeholders), the per-session sum is 0, so fall back to every message.
  const perSessionCost = sessions.reduce((sum, s) => {
    const msgs = Array.isArray(messages[s.id]) ? messages[s.id] : []
    return sum + summarizeSession(s, msgs).cost
  }, 0)
  const totalCost = perSessionCost > 0 ? perSessionCost : summarizeSession(sessions[0], allMessages).cost
  const totalMessages = allMessages.length
  // Tool calls are a far more meaningful "how much work happened" signal than
  // cost, which the Flue runtime does not report per message (so it reads 0).
  const totalTools = allMessages.reduce((sum, m) => sum + (m.parts?.filter(isToolPart).length ?? 0), 0)
  const hasAssistant = allMessages.some((m) => m.info?.role === "assistant")
  const overallStatus =
    detail.status ??
    (() => {
      const statusValues = Object.values(sessionStatus)
      const hasBusy = statusValues.some((s) => s.type === "busy")
      return hasBusy ? "working" : statusValues.length > 0 ? "idle" : "unknown"
    })()
  const observedAt = detail.statusObservedAt ?? detail.updatedAt
  const observedAtIso =
    typeof observedAt === "string" ? observedAt : observedAt ? new Date(observedAt).toISOString() : null

  const handleSend = () => {
    const text = draft.trim()
    if (!text || sendPrompt.isPending) return
    const optId = `opt-${crypto.randomUUID()}`
    setOptimistic((prev) => [
      ...prev,
      {
        info: { id: optId, role: "user", createdAt: new Date().toISOString() },
        parts: [{ type: "text", text }],
      },
    ])
    setDraft("")
    stickToBottomRef.current = true
    sendPrompt.mutate(text, {
      onError: () => {
        setOptimistic((prev) => prev.filter((m) => m.info?.id !== optId))
      },
    })
  }

  return (
    <div className="-m-6 flex h-[calc(100%+3rem)] min-w-0 flex-col overflow-hidden">
      {/* Header bar */}
      <div className="shrink-0 border-b px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate("/containers")}>
            <ArrowLeft className="size-3.5" />
            Back
          </Button>
          <Separator orientation="vertical" className="!h-4" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <StatusDot status={overallStatus} />
              <h1 className="truncate font-mono text-sm font-semibold">
                {ghUrl ? <GitHubLink href={ghUrl}>{entityKey}</GitHubLink> : entityKey}
              </h1>
              {chatRepo && (
                <Badge variant="secondary" className="shrink-0">
                  Chat
                </Badge>
              )}
              <span className="shrink-0 text-[11px] text-muted-foreground">{statusLabel(overallStatus)}</span>
              {streaming && (
                <span
                  className="inline-flex shrink-0 items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400"
                  title="Live updates streaming over SSE"
                >
                  <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
                  Live
                </span>
              )}
            </div>
            <div className="mt-0.5 flex items-center gap-3 text-xs text-muted-foreground">
              {repoName && <GitHubLink href={repoGitHubUrl(repoName)}>{repoName}</GitHubLink>}
              <span className="inline-flex items-center gap-1">
                <Stack className="size-3" />
                {sessions.length}
              </span>
              <span className="inline-flex items-center gap-1" title="Messages">
                <ChatText className="size-3" />
                {totalMessages}
              </span>
              <span className="inline-flex items-center gap-1" title="Tool calls">
                <Wrench className="size-3" />
                {totalTools}
              </span>
              {totalCost > 0 ? (
                <span className="inline-flex items-center gap-1" title="Model cost reported for this run">
                  <CurrencyDollar className="size-3" />${totalCost.toFixed(4)}
                </span>
              ) : (
                hasAssistant && (
                  <span
                    className="inline-flex items-center gap-1 text-muted-foreground/50"
                    title="Token usage / cost isn't reported by the agent runtime for these runs, so there's nothing to total here."
                  >
                    <CurrencyDollar className="size-3" />
                    n/a
                  </span>
                )
              )}
              {observedAtIso && (
                <span className="inline-flex items-center gap-1">
                  <Clock className="size-3" />
                  {formatTimeAgo(observedAtIso)}
                </span>
              )}
              {detail.sandboxHint && <span className="hidden text-[10px] sm:inline">{detail.sandboxHint}</span>}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant={showLogs ? "secondary" : "outline"} size="xs" onClick={() => setShowLogs(!showLogs)}>
              <Terminal className="size-3" /> Logs
            </Button>
            {dataUpdatedAt && (
              <span className="text-[10px] text-muted-foreground">
                {formatTimeAgo(new Date(dataUpdatedAt).toISOString())}
              </span>
            )}
            {headerActions}
          </div>
        </div>
      </div>

      {/* Only alarm once the run is *derived* as sync-unavailable. A fresh working
          run can hit a transient history hiccup (DO spin-up, post-deploy) that
          resolves on the next poll — showing "live sync unavailable" then is
          misleading, so we keep it quiet while the run is still working. */}
      {overallStatus === "sync_unavailable" && (
        <div
          role="status"
          className="flex items-start gap-2 border-b border-border/60 bg-muted/40 px-4 py-2 text-xs text-muted-foreground"
        >
          <Warning className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="min-w-0 flex-1">
            <span className="font-medium text-foreground">Live sync unavailable.</span> Showing the last saved snapshot
            {observedAtIso ? ` (updated ${formatTimeAgo(observedAtIso)})` : ""}. Sandboxes scale to zero after idle —
            this does not mean the run is still active.
            {syncError && (
              <details className="mt-1">
                <summary className="cursor-pointer text-[10px] opacity-80">Technical details</summary>
                <code className="mt-0.5 block break-all font-mono text-[10px] opacity-70">{syncError}</code>
              </details>
            )}
          </div>
          <Button variant="outline" size="xs" className="shrink-0" onClick={() => refetch()} disabled={isFetching}>
            <ArrowClockwise className={`size-3 ${isFetching ? "animate-spin" : ""}`} />
            Retry
          </Button>
        </div>
      )}

      {chatError && (
        <div
          role="alert"
          className="flex items-start gap-2 border-b border-border/60 bg-muted/40 px-4 py-2 text-xs text-muted-foreground"
        >
          <Warning className="mt-0.5 size-3.5 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1">
            <span className="font-medium text-foreground">Chat failed to start.</span> {chatError}
          </div>
        </div>
      )}

      {/* Main content: sidebar + chat */}
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {/* Session sidebar */}
        <div className="flex w-56 shrink-0 flex-col overflow-hidden border-r">
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            <div className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Sessions ({orderedSessions.length})
            </div>
            <div className="space-y-0.5">
              {orderedSessions.map((s) => {
                const ownMessages = Array.isArray(messages[s.id]) ? messages[s.id] : []
                const sessionMessages =
                  ownMessages.length === 0 && orderedSessions.length === 1 ? allMessages : ownMessages
                const itemSummary = summarizeSession(s, sessionMessages)
                return (
                  <SessionSidebarItem
                    key={s.id}
                    session={s}
                    status={sessionStatus[s.id]?.type ?? "unknown"}
                    messageCount={sessionMessages.length}
                    agent={itemSummary.agent}
                    cost={itemSummary.cost}
                    isActive={s.id === effectiveSessionId}
                    onClick={() => setActiveSessionId(s.id)}
                  />
                )
              })}
              {orderedSessions.length === 0 && (
                <div className="px-2 py-4 text-center text-xs text-muted-foreground">No sessions</div>
              )}
            </div>
          </div>
          {!chatRepo && (
            <div className="max-h-48 shrink-0 overflow-y-auto border-t p-2">
              <div className="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Recent events
              </div>
              {entityEvents.isLoading ? (
                <div className="px-2 text-[10px] text-muted-foreground">Loading…</div>
              ) : entityEvents.isError ? (
                <div className="px-2 text-[10px] text-destructive">Couldn't load events</div>
              ) : !entityEvents.data?.data.length ? (
                <div className="px-2 text-[10px] text-muted-foreground">No events</div>
              ) : (
                <div className="space-y-1">
                  {entityEvents.data.data.map((ev) => (
                    <button
                      key={ev.id}
                      type="button"
                      onClick={() => navigate(`/events/${ev.id}`)}
                      className="flex w-full flex-col gap-0.5 rounded px-2 py-1.5 text-left hover:bg-muted/50"
                    >
                      <span className="truncate text-[11px] font-medium">
                        {ev.event}
                        {ev.action ? `.${ev.action}` : ""}
                      </span>
                      <span className="flex items-center gap-1.5">
                        <StatusBadge status={ev.status} />
                        <span className="text-[10px] text-muted-foreground">{formatTimeAgo(ev.createdAt)}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Chat area */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* Active session header */}
          {activeSession && (
            <div className="flex items-center gap-3 border-b px-4 py-2">
              <StatusDot
                status={
                  overallStatus === "sync_unavailable" || overallStatus === "historical"
                    ? overallStatus
                    : (sessionStatus[activeSession.id]?.type ?? "unknown")
                }
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  {activeSession.parentID && <TreeStructure className="size-3 text-muted-foreground/50" />}
                  <span className="truncate text-sm font-medium">{activeSession.title ?? "Session"}</span>
                </div>
                <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                  {activeSummary.agent && (
                    <span className="inline-flex items-center gap-1">
                      <Robot className="size-3" />
                      {activeSummary.agent}
                    </span>
                  )}
                  {activeSummary.model && (
                    <span className="inline-flex items-center gap-1">
                      <Code className="size-3" />
                      {activeSummary.model}
                    </span>
                  )}
                  {activeSummary.cost > 0 && (
                    <span className="inline-flex items-center gap-1">
                      <CurrencyDollar className="size-3" />${activeSummary.cost.toFixed(4)}
                    </span>
                  )}
                  {activeSession.tokens && (
                    <span className="font-mono text-[10px]">
                      {activeSession.tokens.input ?? 0}in / {activeSession.tokens.output ?? 0}out
                    </span>
                  )}
                </div>
              </div>
              <span className="font-mono text-[10px] text-muted-foreground/40">{activeSession.id.slice(0, 16)}...</span>
            </div>
          )}

          <ToolTimeline messages={serverMessages} />

          {/* Messages */}
          <div
            ref={chatScrollRef}
            className="min-w-0 flex-1 overflow-y-auto"
            onScroll={() => {
              const el = chatScrollRef.current
              if (!el) return
              stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
            }}
          >
            {activeMessages.length > 0 ? (
              <div className="min-w-0 divide-y divide-border/30">
                {activeMessages.map((msg, i) => (
                  <div
                    key={msg.info?.id ?? `${effectiveSessionId}-${i}`}
                    className={msg.info?.id?.startsWith("opt-") ? "opacity-70" : undefined}
                  >
                    <ChatMessage message={msg} />
                  </div>
                ))}
                <div ref={chatEndRef} />
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
                <ChatText className="size-6 text-muted-foreground/40" />
                <div className="space-y-1">
                  <p className="text-sm font-medium text-foreground">
                    {overallStatus === "sync_unavailable"
                      ? "No transcript in the saved snapshot"
                      : overallStatus === "working"
                        ? "Waiting for the agent’s first message"
                        : effectiveSessionId
                          ? "No messages in this session yet"
                          : "Select a session to view messages"}
                  </p>
                  <p className="max-w-md text-xs text-muted-foreground">
                    {overallStatus === "sync_unavailable" ? (
                      <>
                        Status: {statusLabel(overallStatus)}
                        {observedAtIso ? ` · last updated ${formatTimeAgo(observedAtIso)}` : ""}. Check recent events in
                        the sidebar, or send guidance below to start a new turn.
                      </>
                    ) : overallStatus === "working" ? (
                      <>
                        The agent is working. Its messages appear here as soon as they sync — this refreshes on its own.
                      </>
                    ) : overallStatus === "historical" ? (
                      <>This run is historical. The sandbox has likely scaled to zero.</>
                    ) : chatError ? (
                      <>Chat failed to start: {chatError}</>
                    ) : chatStarting ? (
                      <>The agent is starting up on {chatRepo}. Your message appears here once it reports in.</>
                    ) : chatRepo ? (
                      <>Send a follow-up below to keep talking to the agent.</>
                    ) : (
                      <>Send operator guidance below to continue the agent, or open a related webhook event.</>
                    )}
                  </p>
                </div>
                {(overallStatus === "sync_unavailable" || overallStatus === "working") && (
                  <Button variant="outline" size="xs" onClick={() => refetch()} disabled={isFetching}>
                    <ArrowClockwise className={`size-3 ${isFetching ? "animate-spin" : ""}`} />
                    {overallStatus === "working" ? "Refresh" : "Retry sync"}
                  </Button>
                )}
              </div>
            )}
          </div>

          {/* Operator composer */}
          <div className="shrink-0 border-t bg-background p-3">
            {chatStarting && (
              <p className="mb-2 text-xs text-muted-foreground">
                Waiting for the agent to pick up the first message before you can send another…
              </p>
            )}
            {sendPrompt.isError && (
              <p id="operator-prompt-error" className="mb-2 text-xs text-destructive" role="alert">
                {sendPrompt.error instanceof Error ? sendPrompt.error.message : "Failed to send"}
              </p>
            )}
            <div className="flex items-end gap-2">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault()
                    handleSend()
                  }
                }}
                disabled={chatStarting || !!chatError}
                aria-label={chatRepo ? "Message to the agent" : "Operator guidance"}
                aria-invalid={sendPrompt.isError || undefined}
                aria-describedby={sendPrompt.isError ? "operator-prompt-error" : undefined}
                placeholder={
                  chatError
                    ? "Chat failed to start"
                    : chatStarting
                      ? "Starting…"
                      : chatRepo
                        ? "Message the agent… (⌘/Ctrl+Enter)"
                        : "Send guidance to the agent… (⌘/Ctrl+Enter)"
                }
                rows={2}
                className="min-h-[2.5rem] flex-1 resize-none border border-input bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
              />
              <Button
                size="sm"
                disabled={!draft.trim() || sendPrompt.isPending || chatStarting || !!chatError}
                onClick={handleSend}
              >
                {sendPrompt.isPending ? (
                  <ArrowClockwise className="size-3.5 animate-spin" />
                ) : (
                  <PaperPlaneTilt className="size-3.5" />
                )}
                {sendPrompt.isPending ? "Sending…" : "Send"}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Logs panel */}
      {showLogs && <LogsPanel logs={logs} onClose={() => setShowLogs(false)} />}
    </div>
  )
}

function hasBusyPlaceholder(messages: SessionMessage[]): boolean {
  return messages.some((m) => m.info?.role === "assistant" && !m.parts?.length)
}
