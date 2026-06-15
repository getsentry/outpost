import {
  ArrowClockwise,
  ArrowLeft,
  CaretDown,
  CaretRight,
  ChatText,
  Clock,
  Code,
  CurrencyDollar,
  Robot,
  Stack,
  Terminal,
  Trash,
  TreeStructure,
  Wrench,
  X,
} from "@phosphor-icons/react"
import { Fragment, useMemo, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { GitHubLink } from "@/client/components/github-link"
import type { SessionDetailResponse, SessionInfo, SessionMessage } from "@/client/lib/api"
import { entityGitHubUrl, formatTime, formatTimeAgo, parseEntityKey, repoGitHubUrl } from "@/client/lib/format"
import { useDestroyContainer, useSessionDetail } from "@/client/lib/queries"
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
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

function StatusDot({ status }: { status: string }) {
  const styles: Record<string, string> = {
    busy: "bg-yellow-500 animate-pulse",
    idle: "bg-green-500",
  }
  return <span className={`inline-block size-2 rounded-full ${styles[status] ?? "bg-gray-400"}`} />
}

// ---------------------------------------------------------------------------
// Chat message components
// ---------------------------------------------------------------------------

function ChatMessage({ message }: { message: SessionMessage }) {
  const [expanded, setExpanded] = useState(false)
  const role = message.info?.role ?? "unknown"
  const parts = message.parts ?? []
  const time = message.info?.createdAt ? formatTime(message.info.createdAt) : null

  const isAssistant = role === "assistant"
  const isUser = role === "user"

  const textParts = parts.filter((p) => p.type === "text" && p.text)
  const toolParts = parts.filter((p) => p.type === "tool-invocation" || p.type === "tool-result")
  const otherParts = parts.filter((p) => p.type !== "text" && p.type !== "tool-invocation" && p.type !== "tool-result")

  const hasVisibleContent = textParts.length > 0 || toolParts.length > 0 || otherParts.length > 0
  if (!hasVisibleContent) return null

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

        {/* Text content */}
        {textParts.map((part, i) => {
          const text = part.text ?? ""
          const isLong = text.length > 1000
          const display = isLong && !expanded ? `${text.slice(0, 1000)}...` : text
          return (
            <Fragment key={i}>
              <pre className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">{display}</pre>
              {isLong && (
                <button
                  type="button"
                  onClick={() => setExpanded(!expanded)}
                  className="mt-1 text-[11px] font-medium text-primary hover:underline"
                >
                  {expanded ? "Show less" : `Show all (${text.length.toLocaleString()} chars)`}
                </button>
              )}
            </Fragment>
          )
        })}

        {/* Tool calls */}
        {toolParts.length > 0 && (
          <div className="mt-2 space-y-1">
            {toolParts.map((part, i) => (
              <ToolCallBlock
                key={i}
                toolName={part.toolName ?? "unknown"}
                isInvocation={part.type === "tool-invocation"}
                state={part.state as string | undefined}
                args={part.type === "tool-invocation" ? part.args : undefined}
                result={part.type !== "tool-invocation" ? part.result : undefined}
              />
            ))}
          </div>
        )}

        {otherParts.map((part, i) => (
          <div key={i} className="mt-1 text-[10px] text-muted-foreground">
            [{part.type}]
          </div>
        ))}
      </div>
    </div>
  )
}

function ToolCallBlock({
  toolName,
  isInvocation,
  state,
  args,
  result,
}: {
  toolName: string
  isInvocation: boolean
  state?: string
  args?: Record<string, unknown>
  result?: unknown
}) {
  const [open, setOpen] = useState(false)

  const stateColors: Record<string, string> = {
    result: "text-green-600 dark:text-green-400",
    call: "text-blue-600 dark:text-blue-400",
    partial_call: "text-yellow-600 dark:text-yellow-400",
  }

  const hasContent = (isInvocation && args && Object.keys(args).length > 0) || (!isInvocation && result != null)

  return (
    <div className="rounded-md border border-border/50 bg-background/80 dark:bg-muted/15">
      <button
        type="button"
        onClick={() => hasContent && setOpen(!open)}
        className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] ${hasContent ? "cursor-pointer hover:bg-muted/30" : "cursor-default"}`}
      >
        <Wrench className="size-3 shrink-0 text-muted-foreground/60" />
        <span className="font-mono font-medium">{toolName}</span>
        {state && <span className={`text-[10px] ${stateColors[state] ?? "text-muted-foreground"}`}>({state})</span>}
        {!isInvocation && <span className="text-[10px] text-green-600 dark:text-green-400">completed</span>}
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
        <div className="border-t border-border/30 px-2.5 py-2">
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all text-[10px] leading-relaxed text-muted-foreground">
            {JSON.stringify(isInvocation ? args : result, null, 2)}
          </pre>
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
  isActive,
  onClick,
}: {
  session: SessionInfo
  status: string
  messageCount: number
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
          {session.agent && <span>{session.agent}</span>}
          <span>
            {messageCount} msg{messageCount !== 1 ? "s" : ""}
          </span>
          {typeof session.cost === "number" && session.cost > 0 && <span>${session.cost.toFixed(4)}</span>}
        </div>
      </div>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Main detail page
// ---------------------------------------------------------------------------

export default function ContainerDetailPage() {
  const { entityKey: rawKey } = useParams<{ entityKey: string }>()
  const entityKey = rawKey ? decodeURIComponent(rawKey) : ""
  const navigate = useNavigate()
  const { data, isLoading, isError, isFetching, refetch, dataUpdatedAt } = useSessionDetail(entityKey)
  const destroyContainer = useDestroyContainer()
  const [showLogs, setShowLogs] = useState(false)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [destroyOpen, setDestroyOpen] = useState(false)

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
            <AlertDialogTitle>Destroy this container?</AlertDialogTitle>
            <AlertDialogDescription>
              This will force-stop the container and delete the session data for{" "}
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
                "Destroy Container"
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

  if (isError || !data) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-2">
          <Button variant="ghost" size="sm" onClick={() => navigate("/containers")}>
            <ArrowLeft className="size-3.5" />
            Back to containers
          </Button>
          {headerActions}
        </div>
        <div className="py-12 text-center text-sm text-muted-foreground">
          Container not found or still starting up. Try refreshing.
        </div>
      </div>
    )
  }

  const detail = data as SessionDetailResponse
  const sessions = detail.sessions ?? []
  const sessionStatus = detail.sessionStatus ?? {}
  const messages = detail.messages ?? {}
  const logs = detail.logs ?? ""

  const ghUrl = entityGitHubUrl(entityKey, "issues")
  const parsed = parseEntityKey(entityKey)
  const repoName = parsed ? `${parsed.owner}/${parsed.repo}` : null

  // Order sessions: root first, then children grouped under parents
  const rootSessions = sessions.filter((s) => !s.parentID)
  const childSessionsByParent = new Map<string, SessionInfo[]>()
  for (const s of sessions) {
    if (s.parentID) {
      const arr = childSessionsByParent.get(s.parentID) ?? []
      arr.push(s)
      childSessionsByParent.set(s.parentID, arr)
    }
  }
  const orderedSessions: SessionInfo[] = []
  for (const root of rootSessions) {
    orderedSessions.push(root)
    const children = childSessionsByParent.get(root.id)
    if (children) orderedSessions.push(...children)
  }
  // Orphaned children
  const placed = new Set(orderedSessions.map((s) => s.id))
  for (const s of sessions) {
    if (!placed.has(s.id)) orderedSessions.push(s)
  }

  // Active session
  const effectiveSessionId = activeSessionId ?? orderedSessions[0]?.id ?? null
  const activeMessages = effectiveSessionId ? (messages[effectiveSessionId] ?? []) : []
  const activeSession = orderedSessions.find((s) => s.id === effectiveSessionId)

  // Summary
  const totalCost = sessions.reduce((sum, s) => sum + (typeof s.cost === "number" ? s.cost : 0), 0)
  const totalMessages = Object.values(messages).reduce((sum, msgs) => sum + (Array.isArray(msgs) ? msgs.length : 0), 0)
  const statusValues = Object.values(sessionStatus)
  const hasBusy = statusValues.some((s) => s.type === "busy")
  const overallStatus = hasBusy ? "busy" : statusValues.length > 0 ? "idle" : "unknown"

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
            </div>
            <div className="mt-0.5 flex items-center gap-3 text-xs text-muted-foreground">
              {repoName && <GitHubLink href={repoGitHubUrl(repoName)}>{repoName}</GitHubLink>}
              <span className="inline-flex items-center gap-1">
                <Stack className="size-3" />
                {sessions.length}
              </span>
              <span className="inline-flex items-center gap-1">
                <ChatText className="size-3" />
                {totalMessages}
              </span>
              {totalCost > 0 && (
                <span className="inline-flex items-center gap-1">
                  <CurrencyDollar className="size-3" />${totalCost.toFixed(4)}
                </span>
              )}
              {detail.updatedAt && (
                <span className="inline-flex items-center gap-1">
                  <Clock className="size-3" />
                  {formatTimeAgo(detail.updatedAt)}
                </span>
              )}
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

      {/* Main content: sidebar + chat */}
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {/* Session sidebar */}
        <div className="w-56 shrink-0 overflow-y-auto border-r p-2">
          <div className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Sessions ({orderedSessions.length})
          </div>
          <div className="space-y-0.5">
            {orderedSessions.map((s) => {
              const msgCount = Array.isArray(messages[s.id]) ? messages[s.id].length : 0
              return (
                <SessionSidebarItem
                  key={s.id}
                  session={s}
                  status={sessionStatus[s.id]?.type ?? "unknown"}
                  messageCount={msgCount}
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

        {/* Chat area */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Active session header */}
          {activeSession && (
            <div className="flex items-center gap-3 border-b px-4 py-2">
              <StatusDot status={sessionStatus[activeSession.id]?.type ?? "unknown"} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  {activeSession.parentID && <TreeStructure className="size-3 text-muted-foreground/50" />}
                  <span className="truncate text-sm font-medium">{activeSession.title ?? "Session"}</span>
                </div>
                <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                  {activeSession.agent && (
                    <span className="inline-flex items-center gap-1">
                      <Robot className="size-3" />
                      {activeSession.agent}
                    </span>
                  )}
                  {activeSession.model?.id && (
                    <span className="inline-flex items-center gap-1">
                      <Code className="size-3" />
                      {activeSession.model.id}
                    </span>
                  )}
                  {typeof activeSession.cost === "number" && activeSession.cost > 0 && (
                    <span className="inline-flex items-center gap-1">
                      <CurrencyDollar className="size-3" />${activeSession.cost.toFixed(4)}
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

          {/* Messages */}
          <div className="flex-1 overflow-y-auto">
            {activeMessages.length > 0 ? (
              <div className="divide-y divide-border/30">
                {activeMessages.map((msg, i) => (
                  <ChatMessage key={msg.info?.id ?? `${effectiveSessionId}-${i}`} message={msg} />
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center gap-2 py-16">
                <ChatText className="size-6 text-muted-foreground/30" />
                <p className="text-sm text-muted-foreground">
                  {effectiveSessionId ? "No messages in this session yet" : "Select a session to view messages"}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Logs panel */}
      {showLogs && <LogsPanel logs={logs} onClose={() => setShowLogs(false)} />}
    </div>
  )
}
