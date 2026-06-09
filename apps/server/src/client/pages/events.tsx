import { CaretLeft, CaretRight, Funnel, ListBullets, MagnifyingGlass, Trash, X } from "@phosphor-icons/react"
import { useEffect, useState } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { GitHubLink } from "@/client/components/github-link"
import { LastUpdated } from "@/client/components/last-updated"
import { StatusBadge } from "@/client/components/status-badge"
import { entityGitHubUrl, formatTimeAgo, repoGitHubUrl } from "@/client/lib/format"
import { useClearEvents, useEventStats, useEvents, useEventsGrouped } from "@/client/lib/queries"
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

const STATUS_OPTIONS = ["all", "pending", "dispatched", "completed", "failed", "skipped"] as const
const PAGE_SIZES = [10, 25, 50] as const

export default function EventsPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [repoInput, setRepoInput] = useState(searchParams.get("repo") ?? "")
  const [groupByRepo, setGroupByRepo] = useState(false)
  const clearEvents = useClearEvents()
  const grouped = useEventsGrouped()
  const { data: stats } = useEventStats()

  const page = Number(searchParams.get("page")) || 1
  const limit = Number(searchParams.get("limit")) || 25
  const statusFilter = searchParams.get("status") ?? "all"
  const repoFilter = searchParams.get("repo") ?? ""

  const { data, isLoading, isError, dataUpdatedAt, isFetching, refetch } = useEvents({
    page,
    limit,
    status: statusFilter !== "all" ? statusFilter : undefined,
    repo: repoFilter || undefined,
  })

  // Sync input with URL param when navigating
  useEffect(() => {
    setRepoInput(searchParams.get("repo") ?? "")
  }, [searchParams])

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
  const setStatus = (s: string) => updateParams({ status: s === "all" ? null : s, page: "1" })

  const applyRepoFilter = () => {
    updateParams({ repo: repoInput || null, page: "1" })
  }

  const clearRepoFilter = () => {
    setRepoInput("")
    updateParams({ repo: null, page: "1" })
  }

  const handleRepoKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") applyRepoFilter()
    if (e.key === "Escape") clearRepoFilter()
  }

  const statusCounts: Record<string, number> = {
    all: stats?.total ?? 0,
    pending: stats?.pending ?? 0,
    dispatched: stats?.dispatched ?? 0,
    completed: stats?.completed ?? 0,
    failed: stats?.failed ?? 0,
    skipped: stats?.skipped ?? 0,
  }

  const pagination = data?.pagination
  const hasActiveFilters = statusFilter !== "all" || !!repoFilter

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Webhook Events</h1>
          <p className="text-sm text-muted-foreground">
            {pagination ? `${pagination.total} events` : "All incoming webhook events from GitHub"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant={groupByRepo ? "default" : "outline"} size="sm" onClick={() => setGroupByRepo(!groupByRepo)}>
            <ListBullets className="mr-1.5 size-4" />
            Group by Repo
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm" disabled={clearEvents.isPending}>
                <Trash className="mr-1.5 size-4" />
                {clearEvents.isPending ? "Clearing..." : "Clear All"}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Clear all webhook events?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will permanently delete all {stats?.total ?? 0} webhook events from the database. This action
                  cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => clearEvents.mutate()}>Clear All Events</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <LastUpdated dataUpdatedAt={dataUpdatedAt} isFetching={isFetching} onRefresh={() => refetch()} />
        </div>
      </div>

      {/* Filters bar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1">
          {STATUS_OPTIONS.map((s) => (
            <Button key={s} variant={statusFilter === s ? "default" : "outline"} size="xs" onClick={() => setStatus(s)}>
              {s === "all" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)}
              <span className="ml-1 opacity-60 tabular-nums">{statusCounts[s] ?? 0}</span>
            </Button>
          ))}
        </div>
        <div className="relative flex items-center">
          <MagnifyingGlass className="absolute left-2 size-3.5 text-muted-foreground" />
          <input
            type="text"
            placeholder="Filter by repo..."
            value={repoInput}
            onChange={(e) => setRepoInput(e.target.value)}
            onKeyDown={handleRepoKeyDown}
            onBlur={applyRepoFilter}
            className="h-7 border border-input bg-background pl-7 pr-7 text-xs outline-none placeholder:text-muted-foreground focus:border-ring"
          />
          {repoInput && (
            <button
              type="button"
              onClick={clearRepoFilter}
              className="absolute right-2 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          )}
        </div>
        {hasActiveFilters && (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              setRepoInput("")
              updateParams({ status: null, repo: null, page: "1" })
            }}
          >
            Clear filters
          </Button>
        )}
        <div className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>Per page:</span>
          {PAGE_SIZES.map((s) => (
            <Button key={s} variant={limit === s ? "secondary" : "ghost"} size="xs" onClick={() => setLimit(s)}>
              {s}
            </Button>
          ))}
        </div>
      </div>

      {/* Grouped view */}
      {groupByRepo && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <ListBullets className="size-4" />
              Events by Repository
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {grouped.isLoading ? (
              <div className="space-y-2 p-4">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-8 w-full" />
                ))}
              </div>
            ) : !grouped.data?.data.length ? (
              <div className="py-8 text-center text-sm text-muted-foreground">No events found</div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Repository</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="text-right">Pending</TableHead>
                    <TableHead className="text-right">Dispatched</TableHead>
                    <TableHead className="text-right">Completed</TableHead>
                    <TableHead className="text-right">Failed</TableHead>
                    <TableHead className="text-right">Skipped</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {grouped.data.data.map((group) => (
                    <TableRow
                      key={group.repo ?? "unknown"}
                      className="cursor-pointer"
                      onClick={() => {
                        if (group.repo) {
                          setRepoInput(group.repo)
                          updateParams({ repo: group.repo, page: "1" })
                          setGroupByRepo(false)
                        }
                      }}
                    >
                      <TableCell className="font-medium">
                        {group.repo ? (
                          <GitHubLink href={repoGitHubUrl(group.repo)}>{group.repo}</GitHubLink>
                        ) : (
                          <span className="text-muted-foreground">unknown</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono">{group.total}</TableCell>
                      <TableCell className="text-right font-mono">{group.pending}</TableCell>
                      <TableCell className="text-right font-mono">{group.dispatched}</TableCell>
                      <TableCell className="text-right font-mono">{group.completed}</TableCell>
                      <TableCell className="text-right font-mono">{group.failed}</TableCell>
                      <TableCell className="text-right font-mono">{group.skipped}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      {/* Events table */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 10 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : isError ? (
            <div className="py-12 text-center text-sm text-destructive">Failed to load events</div>
          ) : !data?.data.length ? (
            <div className="flex flex-col items-center gap-2 py-16">
              <Funnel className="size-8 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">
                {hasActiveFilters ? "No events match your filters" : "No events found"}
              </p>
              {hasActiveFilters && (
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => {
                    setRepoInput("")
                    updateParams({ status: null, repo: null, page: "1" })
                  }}
                >
                  Clear filters
                </Button>
              )}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Event</TableHead>
                  <TableHead>Entity</TableHead>
                  <TableHead>Repo</TableHead>
                  <TableHead>Sender</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Time</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.data.map((event) => {
                  const ghUrl = entityGitHubUrl(event.entityKey, event.event)
                  return (
                    <TableRow key={event.id} className="cursor-pointer" onClick={() => navigate(`/events/${event.id}`)}>
                      <TableCell className="font-medium">
                        {event.event}
                        {event.action ? <span className="text-muted-foreground">.{event.action}</span> : ""}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {ghUrl ? <GitHubLink href={ghUrl}>{event.entityKey}</GitHubLink> : event.entityKey}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {event.repo ? <GitHubLink href={repoGitHubUrl(event.repo)}>{event.repo}</GitHubLink> : "-"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{event.sender ?? "-"}</TableCell>
                      <TableCell>
                        <StatusBadge status={event.status} />
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {formatTimeAgo(event.createdAt)}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
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
