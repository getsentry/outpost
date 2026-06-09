import { ArrowRight, CheckCircle, CircleDashed, Clock, Hourglass, Lightning } from "@phosphor-icons/react"
import { useNavigate } from "react-router-dom"
import { GitHubLink } from "@/client/components/github-link"
import { LastUpdated } from "@/client/components/last-updated"
import { StatusBadge } from "@/client/components/status-badge"
import { formatTimeAgo, repoGitHubUrl } from "@/client/lib/format"
import { useEventStats, useEvents } from "@/client/lib/queries"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

function StatsCards() {
  const { data: stats, isLoading, isError, dataUpdatedAt, isFetching, refetch } = useEventStats()

  if (isLoading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
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

  const cards = [
    { label: "Total Events", value: stats?.total ?? 0, icon: Lightning },
    { label: "Pending", value: stats?.pending ?? 0, icon: CircleDashed },
    { label: "Dispatched", value: stats?.dispatched ?? 0, icon: Hourglass },
    { label: "Completed", value: stats?.completed ?? 0, icon: CheckCircle },
  ]

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-end">
        <LastUpdated dataUpdatedAt={dataUpdatedAt} isFetching={isFetching} onRefresh={() => refetch()} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((card) => (
          <Card key={card.label}>
            <CardHeader>
              <CardDescription className="flex items-center gap-1.5">
                <card.icon className="size-3.5" />
                {card.label}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold tabular-nums">{card.value}</div>
            </CardContent>
          </Card>
        ))}
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
