import { ArrowLeft, CaretDown, CaretRight, Copy } from "@phosphor-icons/react"
import { useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { GitHubLink } from "@/components/github-link"
import { StatusBadge } from "@/components/status-badge"
import { copyToClipboard } from "@/client/lib/clipboard"
import { entityGitHubUrl, formatDate, repoGitHubUrl } from "@/client/lib/format"
import { useEvent } from "@/client/lib/queries"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"

function PayloadViewer({ payload }: { payload: string }) {
  const [expanded, setExpanded] = useState(true)

  let formatted: string
  try {
    formatted = JSON.stringify(JSON.parse(payload), null, 2)
  } catch {
    formatted = payload
  }

  const handleCopy = () => copyToClipboard(formatted)

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="flex cursor-pointer items-center gap-1.5 text-sm" onClick={() => setExpanded(!expanded)}>
          {expanded ? <CaretDown className="size-3.5" /> : <CaretRight className="size-3.5" />}
          Payload
        </CardTitle>
        <Button variant="ghost" size="xs" onClick={handleCopy}>
          <Copy className="size-3" />
          Copy
        </Button>
      </CardHeader>
      {expanded && (
        <CardContent>
          <pre className="max-h-[600px] overflow-auto bg-muted p-4 text-xs leading-relaxed">{formatted}</pre>
        </CardContent>
      )}
    </Card>
  )
}

export default function EventDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { data: event, isLoading, isError } = useEvent(id ?? "")

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (isError || !event) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={() => navigate("/events")}>
          <ArrowLeft className="size-3.5" />
          Back to events
        </Button>
        <div className="py-12 text-center text-sm text-muted-foreground">Event not found</div>
      </div>
    )
  }

  const ghUrl = entityGitHubUrl(event.entityKey, event.event)

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate("/events")}>
          <ArrowLeft className="size-3.5" />
          Back
        </Button>
        <Separator orientation="vertical" className="!h-4" />
        <h1 className="text-lg font-semibold">
          {event.event}
          {event.action ? `.${event.action}` : ""}
        </h1>
        <StatusBadge status={event.status} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Event Details</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <dt className="text-xs text-muted-foreground">Event Type</dt>
              <dd className="text-sm">{event.event}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Action</dt>
              <dd className="text-sm">{event.action ?? "-"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Status</dt>
              <dd>
                <StatusBadge status={event.status} />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Delivery ID</dt>
              <dd className="font-mono text-sm">{event.deliveryId}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Repository</dt>
              <dd className="text-sm">
                {event.repo ? <GitHubLink href={repoGitHubUrl(event.repo)}>{event.repo}</GitHubLink> : "-"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Sender</dt>
              <dd className="text-sm">{event.sender ?? "-"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Entity Key</dt>
              <dd className="font-mono text-sm">
                {ghUrl ? <GitHubLink href={ghUrl}>{event.entityKey}</GitHubLink> : event.entityKey}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Installation ID</dt>
              <dd className="text-sm">{event.installationId ?? "-"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Created</dt>
              <dd className="text-sm">{formatDate(event.createdAt)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Dispatched</dt>
              <dd className="text-sm">{formatDate(event.dispatchedAt)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Completed</dt>
              <dd className="text-sm">{formatDate(event.completedAt)}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <PayloadViewer payload={event.payload} />
    </div>
  )
}
