import {
  CaretDown,
  CaretLeft,
  CaretRight,
  ChatsCircle,
  MagnifyingGlass,
  Robot,
  Stack,
  Trash,
  X,
} from "@phosphor-icons/react"
import { useEffect, useRef, useState } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import type { SessionListItem } from "@/client/lib/api"
import { entityGitHubUrl, formatTimeAgo, parseEntityKey, repoGitHubUrl } from "@/client/lib/format"
import { useClearSessions, useSessions } from "@/client/lib/queries"
import { ClearSessionsFeedback } from "@/components/clear-sessions-feedback"
import { GitHubLink } from "@/components/github-link"
import { LastUpdated } from "@/components/last-updated"
import { NewChatDialog } from "@/components/new-chat-dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { Card, CardContent } from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { chatEntityRepo } from "@/lib/containers/chat-run"
import { runStatusLabel, runStatusNotice } from "@/lib/containers/run-status"

const PAGE_SIZES = [10, 25, 50] as const

function activitySourceLabel(source: NonNullable<SessionListItem["activityPreview"]>["source"]): string {
  switch (source) {
    case "github":
      return "GitHub"
    case "operator":
      return "Operator"
    default:
      return "Message"
  }
}

function StatusIndicator({ status }: { status: string }) {
  const notice = runStatusNotice(status)
  if (notice) return <Badge variant={status === "sync_unavailable" ? "outline" : "destructive"}>{notice.title}</Badge>
  const config: Record<string, { bg: string; dot: string; label: string }> = {
    working: {
      bg: "bg-yellow-50 text-yellow-700 dark:bg-yellow-950/50 dark:text-yellow-300",
      dot: "bg-yellow-500 animate-pulse",
      label: "Working",
    },
    // Legacy API value before display-status rollout
    busy: {
      bg: "bg-yellow-50 text-yellow-700 dark:bg-yellow-950/50 dark:text-yellow-300",
      dot: "bg-yellow-500 animate-pulse",
      label: "Working",
    },
    idle: {
      bg: "bg-green-50 text-green-700 dark:bg-green-950/50 dark:text-green-300",
      dot: "bg-green-500",
      label: "Idle",
    },
    historical: {
      bg: "bg-muted text-muted-foreground",
      dot: "bg-muted-foreground/50",
      label: "Historical",
    },
    unknown: {
      bg: "bg-gray-50 text-gray-600 dark:bg-gray-900 dark:text-gray-400",
      dot: "bg-gray-400",
      label: "Offline",
    },
  }
  const c = config[status] ?? config.unknown
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${c.bg}`}>
      <span className={`inline-block size-1.5 rounded-full ${c.dot}`} />
      {c.label}
    </span>
  )
}

type ClearMode = "all" | "idle"

export default function SessionsPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [searchInput, setSearchInput] = useState("")
  const [clearMode, setClearMode] = useState<ClearMode | null>(null)
  const clearSessions = useClearSessions()

  const page = Number(searchParams.get("page")) || 1
  const limit = Number(searchParams.get("limit")) || 25

  const { data, isLoading, isError, dataUpdatedAt, isFetching, refetch } = useSessions({ page, limit })

  const updateParams = (updates: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams)
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === "") {
        next.delete(key)
      } else {
        next.set(key, value)
      }
    }
    setSearchParams(next)
  }

  const setPage = (p: number) => updateParams({ page: String(p) })
  const setLimit = (l: number) => updateParams({ limit: String(l), page: "1" })

  const filtered = data?.data
    .filter((session: SessionListItem) => {
      if (!searchInput) return true
      const q = searchInput.toLowerCase()
      return (
        session.entityKey.toLowerCase().includes(q) ||
        (session.title ?? "").toLowerCase().includes(q) ||
        (session.agent ?? "").toLowerCase().includes(q)
      )
    })
    // Active runs float to the top; after that, newest activity is the useful
    // navigation order rather than an arbitrary entity-key sort.
    .slice()
    .sort((a, b) => {
      const rank = (s: SessionListItem) => (s.status === "working" || s.status === "busy" ? 0 : 1)
      const byActive = rank(a) - rank(b)
      if (byActive !== 0) return byActive
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    })

  const pagination = data?.pagination
  const clearing = clearSessions.isPending
  const clearAttemptFinished = clearSessions.isError || clearSessions.isSuccess
  const closeClearRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    // The focused submit button disappears after a partial/failed attempt.
    if (clearAttemptFinished) closeClearRef.current?.focus()
  }, [clearAttemptFinished])
  const confirmClear = (mode: ClearMode) => {
    clearSessions.reset()
    setClearMode(mode)
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-lg font-semibold">Agent runs</h1>
          <p className="text-sm text-muted-foreground">
            {pagination
              ? `${pagination.total} agent run${pagination.total !== 1 ? "s" : ""}`
              : "Recent agent conversations"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <NewChatDialog />
          <ButtonGroup aria-label="Clear agent runs">
            <Button
              variant="outline"
              size="sm"
              disabled={clearing || !pagination?.total}
              onClick={() => confirmClear("all")}
            >
              <Trash className="mr-1.5 size-4" />
              {clearing && clearMode === "all" ? "Clearing..." : "Clear All"}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="outline" size="sm" className="px-2" />}
                disabled={clearing || !pagination?.total}
                aria-label="More clear options"
              >
                <CaretDown className="size-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-48">
                <DropdownMenuGroup>
                  <DropdownMenuItem onClick={() => confirmClear("idle")}>Clear idle entries</DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </ButtonGroup>
          <AlertDialog open={clearMode !== null} onOpenChange={(open) => !open && !clearing && setClearMode(null)}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {clearAttemptFinished
                    ? "Cleanup results"
                    : clearMode === "idle"
                      ? "Clear idle agent runs?"
                      : "Destroy all agent runs?"}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {clearAttemptFinished ? (
                    <>Review the results below. No further runs will be deleted from this dialog.</>
                  ) : clearMode === "idle" ? (
                    <>
                      This will permanently delete Idle, Historical, and Sync unavailable run records. Working runs are
                      left alone, and no sandboxes will be destroyed. This action cannot be undone.
                    </>
                  ) : (
                    <>
                      This will permanently delete the current agent runs, including chat history, files, scheduled
                      work, and stored events. There are currently {pagination?.total ?? 0} runs. New runs started
                      during cleanup are left alone. This action cannot be undone.
                    </>
                  )}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <ClearSessionsFeedback result={clearSessions.data} error={clearSessions.error} />
              <AlertDialogFooter>
                <AlertDialogCancel ref={closeClearRef} disabled={clearing}>
                  {clearAttemptFinished ? "Close" : "Cancel"}
                </AlertDialogCancel>
                {!clearAttemptFinished && (
                  <AlertDialogAction
                    disabled={clearing}
                    onClick={(e) => {
                      e.preventDefault()
                      if (!clearMode) return
                      clearSessions.mutate(clearMode, {
                        onSuccess: (result) => {
                          if (result.ok) setClearMode(null)
                        },
                      })
                    }}
                  >
                    {clearing ? "Clearing..." : clearMode === "idle" ? "Clear Idle Entries" : "Destroy All Runs"}
                  </AlertDialogAction>
                )}
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <LastUpdated dataUpdatedAt={dataUpdatedAt} isFetching={isFetching} onRefresh={() => refetch()} />
        </div>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex w-full items-center sm:w-72">
          <MagnifyingGlass className="absolute left-2 size-3.5 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search by entity, title, or agent..."
            aria-label="Search agent runs"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="h-7 w-full border border-input bg-background pl-7 pr-7 text-xs outline-none placeholder:text-muted-foreground focus:border-ring"
          />
          {searchInput && (
            <button
              type="button"
              onClick={() => setSearchInput("")}
              aria-label="Clear agent-run search"
              className="absolute right-2 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground sm:ml-auto">
          <span>Per page:</span>
          {PAGE_SIZES.map((s) => (
            <Button key={s} variant={limit === s ? "secondary" : "ghost"} size="xs" onClick={() => setLimit(s)}>
              {s}
            </Button>
          ))}
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : isError ? (
            <div className="py-12 text-center text-sm text-destructive">Failed to load sessions</div>
          ) : !filtered?.length ? (
            <div className="flex flex-col items-center gap-2 py-16">
              <Robot className="size-8 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">
                {searchInput
                  ? "No runs match your search"
                  : "No agent runs yet. Runs start from a GitHub event — or you can start one yourself."}
              </p>
              {!searchInput && (
                <NewChatDialog
                  trigger={
                    <Button variant="outline" size="sm">
                      <ChatsCircle data-icon="inline-start" />
                      Start a chat
                    </Button>
                  }
                />
              )}
            </div>
          ) : (
            <>
              {/* Mobile: stacked cards (the wide table doesn't fit a phone). The
                  card is a clickable div (not a button) so the entity/repo
                  GitHub links — anchors that stop propagation — can nest inside
                  it while the surrounding area still navigates to the detail. */}
              <ul className="divide-y md:hidden">
                {filtered.map((session: SessionListItem) => {
                  const ghUrl = entityGitHubUrl(session.entityKey, "issues")
                  const parsed = parseEntityKey(session.entityKey)
                  const chatRepo = chatEntityRepo(session.entityKey)
                  const repoName = parsed ? `${parsed.owner}/${parsed.repo}` : chatRepo
                  const detailHref = `/containers/detail?key=${encodeURIComponent(session.entityKey)}`
                  const openDetail = () => navigate(detailHref)

                  return (
                    <li key={session.entityKey}>
                      {/* biome-ignore lint/a11y/useSemanticElements: a <button> can't wrap the
                          nested GitHub anchors, so this stays a keyboard-operable div */}
                      <div
                        role="button"
                        tabIndex={0}
                        className="flex w-full cursor-pointer flex-col gap-2 px-4 py-3 text-left transition-colors hover:bg-muted/40"
                        onClick={openDetail}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault()
                            openDetail()
                          }
                        }}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 font-mono text-sm">
                            {ghUrl ? (
                              <GitHubLink href={ghUrl}>
                                <span className="break-all">{session.entityKey}</span>
                              </GitHubLink>
                            ) : (
                              <span className="break-all">{session.entityKey}</span>
                            )}
                            {chatRepo && (
                              <Badge variant="secondary" className="font-sans">
                                Chat
                              </Badge>
                            )}
                          </div>
                          <StatusIndicator status={session.status} />
                        </div>
                        {session.title && <p className="line-clamp-2 text-xs text-muted-foreground">{session.title}</p>}
                        {(session.agent || session.model) && (
                          <p className="text-[11px] text-muted-foreground">
                            {[session.agent, session.model].filter(Boolean).join(" · ")}
                          </p>
                        )}
                        {session.activityPreview && (
                          <p className="line-clamp-2 text-xs text-muted-foreground">
                            <span className="font-medium text-foreground">
                              {activitySourceLabel(session.activityPreview.source)}
                              {session.activityPreview.eventLabel ? ` · ${session.activityPreview.eventLabel}` : ""}
                              {session.activityPreview.sender ? ` · ${session.activityPreview.sender}` : ""}
                            </span>
                            {session.activityPreview.summary ? ` · ${session.activityPreview.summary}` : ""}
                          </p>
                        )}
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                          <span className="inline-flex items-center gap-1">
                            <Stack className="size-3" />
                            {session.sessionCount} session{session.sessionCount !== 1 ? "s" : ""}
                          </span>
                          <span className="inline-flex items-center gap-1">
                            <ChatsCircle className="size-3" />
                            {session.messageCount} msg{session.messageCount !== 1 ? "s" : ""}
                          </span>
                          {repoName && (
                            <GitHubLink href={repoGitHubUrl(repoName)}>
                              <span className="text-[10px]">{repoName}</span>
                            </GitHubLink>
                          )}
                          <span className="ml-auto">{formatTimeAgo(session.updatedAt)}</span>
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ul>

              {/* Desktop: full table. */}
              <div className="hidden w-full overflow-x-auto md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="min-w-[240px]">Entity</TableHead>
                      <TableHead className="min-w-[220px]">Latest activity</TableHead>
                      <TableHead className="min-w-[140px]">Agent</TableHead>
                      <TableHead className="w-[90px] text-center">Status</TableHead>
                      <TableHead className="w-[80px] text-center">
                        <span className="inline-flex items-center gap-1">
                          <Stack className="size-3" /> Sessions
                        </span>
                      </TableHead>
                      <TableHead className="w-[80px] text-center">
                        <span className="inline-flex items-center gap-1">
                          <ChatsCircle className="size-3" /> Msgs
                        </span>
                      </TableHead>
                      <TableHead className="w-[100px] text-right">Updated</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.map((session: SessionListItem) => {
                      const ghUrl = entityGitHubUrl(session.entityKey, "issues")
                      const parsed = parseEntityKey(session.entityKey)
                      const chatRepo = chatEntityRepo(session.entityKey)
                      const repoName = parsed ? `${parsed.owner}/${parsed.repo}` : chatRepo

                      return (
                        <TableRow
                          key={session.entityKey}
                          className="cursor-pointer"
                          onClick={() => navigate(`/containers/detail?key=${encodeURIComponent(session.entityKey)}`)}
                        >
                          <TableCell>
                            <div className="space-y-0.5">
                              <div className="flex items-center gap-2 font-mono text-sm">
                                {ghUrl ? <GitHubLink href={ghUrl}>{session.entityKey}</GitHubLink> : session.entityKey}
                                {chatRepo && (
                                  <Badge variant="secondary" className="font-sans">
                                    Chat
                                  </Badge>
                                )}
                              </div>
                              {(session.title || repoName) && (
                                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                  {session.title && <span className="truncate">{session.title}</span>}
                                  {repoName && (
                                    <GitHubLink href={repoGitHubUrl(repoName)}>
                                      <span className="text-[10px]">{repoName}</span>
                                    </GitHubLink>
                                  )}
                                </div>
                              )}
                            </div>
                          </TableCell>
                          <TableCell>
                            {session.activityPreview ? (
                              <div className="space-y-0.5 text-xs">
                                <div className="flex items-center gap-1.5">
                                  <Badge variant="secondary" className="text-[10px]">
                                    {runStatusNotice(session.activityPreview.state)
                                      ? runStatusLabel(session.activityPreview.state)
                                      : session.activityPreview.state === "working"
                                        ? "Working"
                                        : session.activityPreview.state === "skipped"
                                          ? "No action"
                                          : session.activityPreview.source === "github"
                                            ? "GitHub"
                                            : "Operator"}
                                  </Badge>
                                  {session.activityPreview.eventLabel && (
                                    <span className="truncate font-mono text-[10px] text-muted-foreground">
                                      {session.activityPreview.eventLabel}
                                    </span>
                                  )}
                                  {session.activityPreview.sender && (
                                    <span className="truncate text-[10px] text-muted-foreground">
                                      {session.activityPreview.sender}
                                    </span>
                                  )}
                                </div>
                                {session.activityPreview.summary && (
                                  <p className="line-clamp-2 text-muted-foreground">
                                    {session.activityPreview.summary}
                                  </p>
                                )}
                              </div>
                            ) : (
                              <span className="text-xs text-muted-foreground">No transcript preview</span>
                            )}
                          </TableCell>
                          <TableCell>
                            <div className="space-y-0.5">
                              <div className="text-sm">{session.agent ?? "-"}</div>
                              {session.model && (
                                <div className="truncate text-[11px] text-muted-foreground">{session.model}</div>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="text-center">
                            <StatusIndicator status={session.status} />
                          </TableCell>
                          <TableCell className="text-center font-mono text-sm tabular-nums">
                            {session.sessionCount}
                          </TableCell>
                          <TableCell className="text-center font-mono text-sm tabular-nums">
                            {session.messageCount}
                          </TableCell>
                          <TableCell className="text-right text-muted-foreground">
                            {formatTimeAgo(session.updatedAt)}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {pagination && pagination.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            Showing {(pagination.page - 1) * pagination.limit + 1}–
            {Math.min(pagination.page * pagination.limit, pagination.total)} of {pagination.total}
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="xs"
              disabled={pagination.page <= 1}
              onClick={() => setPage(pagination.page - 1)}
            >
              <CaretLeft className="size-3" />
              Prev
            </Button>
            <span className="px-2 text-xs tabular-nums text-muted-foreground">
              {pagination.page} / {pagination.totalPages}
            </span>
            <Button
              variant="outline"
              size="xs"
              disabled={pagination.page >= pagination.totalPages}
              onClick={() => setPage(pagination.page + 1)}
            >
              Next
              <CaretRight className="size-3" />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
