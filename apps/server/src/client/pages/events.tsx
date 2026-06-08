import { CaretLeft, CaretRight, Funnel } from "@phosphor-icons/react"
import { useState } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { GitHubLink } from "@/client/components/github-link"
import { LastUpdated } from "@/client/components/last-updated"
import { StatusBadge } from "@/client/components/status-badge"
import { formatTime, repoGitHubUrl } from "@/client/lib/format"
import { useEvents } from "@/client/lib/queries"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

const STATUS_OPTIONS = ["all", "pending", "dispatched", "completed", "failed", "timeout", "skipped"] as const
const PAGE_SIZES = [10, 25, 50] as const

export default function EventsPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [repoFilter, setRepoFilter] = useState(searchParams.get("repo") ?? "")

  const page = Number(searchParams.get("page")) || 1
  const limit = Number(searchParams.get("limit")) || 25
  const statusFilter = searchParams.get("status") ?? "all"

  const { data, isLoading, isError, dataUpdatedAt, isFetching, refetch } = useEvents({
    page,
    limit,
    status: statusFilter !== "all" ? statusFilter : undefined,
    repo: repoFilter || undefined,
  })

  const setPage = (p: number) => {
    const next = new URLSearchParams(searchParams)
    next.set("page", String(p))
    setSearchParams(next)
  }

  const setLimit = (l: number) => {
    const next = new URLSearchParams(searchParams)
    next.set("limit", String(l))
    next.set("page", "1")
    setSearchParams(next)
  }

  const setStatus = (s: string) => {
    const next = new URLSearchParams(searchParams)
    if (s === "all") {
      next.delete("status")
    } else {
      next.set("status", s)
    }
    next.set("page", "1")
    setSearchParams(next)
  }

  const handleRepoSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const next = new URLSearchParams(searchParams)
    if (repoFilter) {
      next.set("repo", repoFilter)
    } else {
      next.delete("repo")
    }
    next.set("page", "1")
    setSearchParams(next)
  }

  const pagination = data?.pagination

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Webhook Events</h1>
          <p className="text-sm text-muted-foreground">All incoming webhook events from GitHub</p>
        </div>
        <LastUpdated dataUpdatedAt={dataUpdatedAt} isFetching={isFetching} onRefresh={() => refetch()} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Funnel className="size-4" />
            Filters
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1">
              {STATUS_OPTIONS.map((s) => (
                <Button
                  key={s}
                  variant={statusFilter === s ? "default" : "outline"}
                  size="xs"
                  onClick={() => setStatus(s)}
                >
                  {s === "all" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)}
                </Button>
              ))}
            </div>
            <form onSubmit={handleRepoSubmit} className="flex items-center gap-1.5">
              <input
                type="text"
                placeholder="Filter by repo..."
                value={repoFilter}
                onChange={(e) => setRepoFilter(e.target.value)}
                className="h-6 border border-input bg-background px-2 text-xs outline-none placeholder:text-muted-foreground focus:border-ring"
              />
              <Button type="submit" variant="outline" size="xs">
                Apply
              </Button>
            </form>
            <div className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
              <span>Per page:</span>
              {PAGE_SIZES.map((s) => (
                <Button key={s} variant={limit === s ? "secondary" : "ghost"} size="xs" onClick={() => setLimit(s)}>
                  {s}
                </Button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

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
            <div className="py-12 text-center text-sm text-muted-foreground">No events found</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Event</TableHead>
                  <TableHead>Repo</TableHead>
                  <TableHead>Sender</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Delivery ID</TableHead>
                  <TableHead className="text-right">Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.data.map((event) => (
                  <TableRow key={event.id} className="cursor-pointer" onClick={() => navigate(`/events/${event.id}`)}>
                    <TableCell className="font-medium">
                      {event.event}
                      {event.action ? `.${event.action}` : ""}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {event.repo ? <GitHubLink href={repoGitHubUrl(event.repo)}>{event.repo}</GitHubLink> : "-"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{event.sender ?? "-"}</TableCell>
                    <TableCell>
                      <StatusBadge status={event.status} />
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {event.deliveryId.slice(0, 8)}...
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">{formatTime(event.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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
            <span className="px-2 text-xs text-muted-foreground">
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
