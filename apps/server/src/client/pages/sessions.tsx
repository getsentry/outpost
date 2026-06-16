import {
  CaretLeft,
  CaretRight,
  ChatsCircle,
  CurrencyDollar,
  MagnifyingGlass,
  Robot,
  Stack,
  Trash,
  X,
} from "@phosphor-icons/react"
import { useState } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { GitHubLink } from "@/components/github-link"
import { LastUpdated } from "@/components/last-updated"
import type { SessionListItem } from "@/client/lib/api"
import { entityGitHubUrl, formatTimeAgo, parseEntityKey, repoGitHubUrl } from "@/client/lib/format"
import { useClearSessions, useSessions } from "@/client/lib/queries"
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
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

const PAGE_SIZES = [10, 25, 50] as const

function StatusIndicator({ status }: { status: string }) {
  const config: Record<string, { bg: string; dot: string; label: string }> = {
    busy: {
      bg: "bg-yellow-50 text-yellow-700 dark:bg-yellow-950/50 dark:text-yellow-300",
      dot: "bg-yellow-500 animate-pulse",
      label: "Active",
    },
    idle: {
      bg: "bg-green-50 text-green-700 dark:bg-green-950/50 dark:text-green-300",
      dot: "bg-green-500",
      label: "Idle",
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

export default function SessionsPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [searchInput, setSearchInput] = useState("")
  const [clearDialogOpen, setClearDialogOpen] = useState(false)
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

  const filtered = data?.data.filter((session: SessionListItem) => {
    if (!searchInput) return true
    const q = searchInput.toLowerCase()
    return (
      session.entityKey.toLowerCase().includes(q) ||
      (session.title ?? "").toLowerCase().includes(q) ||
      (session.agent ?? "").toLowerCase().includes(q)
    )
  })

  const pagination = data?.pagination

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Containers</h1>
          <p className="text-sm text-muted-foreground">
            {pagination ? `${pagination.total} container${pagination.total !== 1 ? "s" : ""}` : "Live agent containers"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <AlertDialog open={clearDialogOpen} onOpenChange={setClearDialogOpen}>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm" disabled={clearSessions.isPending || !pagination?.total}>
                <Trash className="mr-1.5 size-4" />
                {clearSessions.isPending ? "Clearing..." : "Clear All"}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Clear all agent sessions?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will permanently delete all {pagination?.total ?? 0} agent session records from the database.
                  Running containers will not be affected. This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    clearSessions.mutate()
                    setClearDialogOpen(false)
                  }}
                >
                  Clear All Sessions
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <LastUpdated dataUpdatedAt={dataUpdatedAt} isFetching={isFetching} onRefresh={() => refetch()} />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div className="relative flex items-center">
          <MagnifyingGlass className="absolute left-2 size-3.5 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search by entity, title, or agent..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="h-7 w-72 border border-input bg-background pl-7 pr-7 text-xs outline-none placeholder:text-muted-foreground focus:border-ring"
          />
          {searchInput && (
            <button
              type="button"
              onClick={() => setSearchInput("")}
              className="absolute right-2 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          )}
        </div>
        <div className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
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
                  ? "No sessions match your search"
                  : "No agent sessions yet. Sessions appear when the agent starts working."}
              </p>
            </div>
          ) : (
            <div className="w-full overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="min-w-[240px]">Entity</TableHead>
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
                    <TableHead className="w-[80px] text-right">
                      <span className="inline-flex items-center gap-1">
                        <CurrencyDollar className="size-3" /> Cost
                      </span>
                    </TableHead>
                    <TableHead className="w-[100px] text-right">Updated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((session: SessionListItem) => {
                    const ghUrl = entityGitHubUrl(session.entityKey, "issues")
                    const parsed = parseEntityKey(session.entityKey)
                    const repoName = parsed ? `${parsed.owner}/${parsed.repo}` : null

                    return (
                      <TableRow
                        key={session.entityKey}
                        className="cursor-pointer"
                        onClick={() => navigate(`/containers/detail?key=${encodeURIComponent(session.entityKey)}`)}
                      >
                        <TableCell>
                          <div className="space-y-0.5">
                            <div className="font-mono text-sm">
                              {ghUrl ? <GitHubLink href={ghUrl}>{session.entityKey}</GitHubLink> : session.entityKey}
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
                        <TableCell className="text-right font-mono text-sm tabular-nums">
                          {session.totalCost > 0 ? `$${session.totalCost.toFixed(2)}` : "-"}
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
