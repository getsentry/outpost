import { ArrowRight, CheckCircle, CircleDashed, Clock, Hourglass, Warning } from "@phosphor-icons/react"
import { useNavigate } from "react-router-dom"
import { formatTimeAgo, repoGitHubUrl } from "@/client/lib/format"
import { useEventStats, useEvents } from "@/client/lib/queries"
import { GitHubLink } from "@/components/github-link"
import { LastUpdated } from "@/components/last-updated"
import { StatusBadge } from "@/components/status-badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

function StatsCards() {
  const navigate = useNavigate()
  const { data: stats, isLoading, isError, dataUpdatedAt, isFetching, refetch } = useEventStats()

  if (isLoading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Card key={i}>
            <CardHeader>
              <Skeleton className="h-4 w-24" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-8 w-16" />
            </CardContent>
          </Card>
        ))}
      </div>
    )
  }

  if (isError) {
    return <div className="py-4 text-center text-sm text-destructive">Failed to load stats</div>
  }

  const queues = [
    {
      label: "Stuck",
      value: stats?.stuck ?? 0,
      description: "Delivery has not started",
      icon: Warning,
      status: "d:boot",
      tone: "text-amber-700 dark:text-amber-300",
    },
    {
      label: "Failed",
      value: stats?.failed ?? 0,
      description: "Delivery needs investigation",
      icon: Warning,
      status: "failed",
      tone: "text-red-700 dark:text-red-300",
    },
    {
      label: "Pending",
      value: stats?.pending ?? 0,
      description: "Waiting for dispatch",
      icon: CircleDashed,
      status: "pending",
      tone: "text-foreground",
    },
    {
      label: "Admitted",
      value: stats?.admitted ?? 0,
      description: "Submitted to the agent",
      icon: Hourglass,
      status: "admitted",
      tone: "text-foreground",
    },
    {
      label: "Settled",
      value: stats?.settled ?? 0,
      description: "Agent receipt confirmed",
      icon: CheckCircle,
      status: "settled",
      tone: "text-foreground",
    },
  ]

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-end">
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">
            {stats?.maintenance
              ? `Scheduler ran ${formatTimeAgo(stats.maintenance.completedAt)}`
              : "Scheduler has not reported"}
          </span>
          <LastUpdated dataUpdatedAt={dataUpdatedAt} isFetching={isFetching} onRefresh={() => refetch()} />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {queues.map((queue) => (
          <button
            key={queue.label}
            type="button"
            onClick={() => navigate(`/events?status=${encodeURIComponent(queue.status)}`)}
            className="rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Card className="h-full transition-colors hover:bg-muted/40">
              <CardHeader className="pb-2">
                <CardDescription className="flex items-center gap-1.5">
                  <queue.icon className={`size-3.5 ${queue.tone}`} />
                  {queue.label}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className={`text-2xl font-bold tabular-nums ${queue.tone}`}>{queue.value}</div>
                <p className="mt-1 text-[11px] text-muted-foreground">{queue.description}</p>
              </CardContent>
            </Card>
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 px-1 text-xs text-muted-foreground">
        <span>
          <strong className="font-medium text-foreground">{stats?.completed ?? 0}</strong> completed
        </span>
        <span>
          <strong className="font-medium text-foreground">{stats?.skipped ?? 0}</strong> skipped
        </span>
        <span>
          <strong className="font-medium text-foreground">{stats?.last24h ?? 0}</strong> events in the last 24h
        </span>
        <span>
          <strong className="font-medium text-foreground">{stats?.total ?? 0}</strong> total retained events
        </span>
      </div>
    </div>
  )
}

function RecentEvents() {
  const navigate = useNavigate()
  const { data, isLoading, isError } = useEvents({ limit: 10 })

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Recent Events</CardTitle>
            <CardDescription className="flex items-center gap-1.5">
              <Clock className="size-3.5" />
              Last 10 webhook events
            </CardDescription>
          </div>
          <Button variant="ghost" size="sm" onClick={() => navigate("/events")}>
            View all
            <ArrowRight className="ml-1 size-3.5" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="px-0">
        {isLoading ? (
          <div className="space-y-2 px-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : isError ? (
          <div className="px-4 py-8 text-center text-sm text-destructive">Failed to load events</div>
        ) : !data?.data.length ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">No webhook events yet</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Event</TableHead>
                <TableHead>Repo</TableHead>
                <TableHead>Sender</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.data.map((event) => (
                <TableRow
                  key={event.id}
                  className={`cursor-pointer ${event.status === "skipped" ? "opacity-55" : ""}`}
                  onClick={() => navigate(`/events/${event.id}`)}
                >
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
                  <TableCell className="text-right text-muted-foreground">{formatTimeAgo(event.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

export default function DashboardPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Dashboard</h1>
        <p className="text-sm text-muted-foreground">Overview of incoming webhook events</p>
      </div>
      <StatsCards />
      <RecentEvents />
    </div>
  )
}
