import { CaretDown, CaretLeft, CaretRight, CaretRight as CaretRightIcon, Copy } from "@phosphor-icons/react"
import { Fragment, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { GitHubLink } from "@/client/components/github-link"
import { LastUpdated } from "@/client/components/last-updated"
import { copyToClipboard } from "@/client/lib/clipboard"
import { entityGitHubUrl, formatTimeAgo } from "@/client/lib/format"
import { useSessionDetail, useSessions } from "@/client/lib/queries"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

const PAGE_SIZES = [10, 25, 50] as const

function SessionExpandedRow({ entityKey }: { entityKey: string }) {
  const { data, isLoading, isError } = useSessionDetail(entityKey)

  if (isLoading) {
    return (
      <TableRow>
        <TableCell colSpan={4} className="bg-muted/30 p-4">
          <Skeleton className="h-32 w-full" />
        </TableCell>
      </TableRow>
    )
  }

  if (isError || !data) {
    return (
      <TableRow>
        <TableCell colSpan={4} className="bg-muted/30 p-4 text-sm text-destructive">
          Failed to load session data
        </TableCell>
      </TableRow>
    )
  }

  let formatted: string
  try {
    formatted = JSON.stringify(JSON.parse(data.sessionData), null, 2)
  } catch {
    formatted = data.sessionData
  }

  const handleCopy = () => copyToClipboard(formatted)

  return (
    <TableRow>
      <TableCell colSpan={4} className="bg-muted/30 p-0">
        <div className="p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">Session Data</span>
            <Button variant="ghost" size="xs" onClick={handleCopy}>
              <Copy className="size-3" />
              Copy
            </Button>
          </div>
          <pre className="max-h-[400px] overflow-auto bg-muted p-4 text-xs leading-relaxed">{formatted}</pre>
        </div>
      </TableCell>
    </TableRow>
  )
}

export default function SessionsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [expandedKey, setExpandedKey] = useState<string | null>(null)

  const page = Number(searchParams.get("page")) || 1
  const limit = Number(searchParams.get("limit")) || 25

  const { data, isLoading, isError, dataUpdatedAt, isFetching, refetch } = useSessions({ page, limit })

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

  const toggleExpand = (entityKey: string) => {
    setExpandedKey((prev) => (prev === entityKey ? null : entityKey))
  }

  const pagination = data?.pagination

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Agent Sessions</h1>
          <p className="text-sm text-muted-foreground">Active agent sessions for GitHub entities</p>
        </div>
        <LastUpdated dataUpdatedAt={dataUpdatedAt} isFetching={isFetching} onRefresh={() => refetch()} />
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 10 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : isError ? (
            <div className="py-12 text-center text-sm text-destructive">Failed to load sessions</div>
          ) : !data?.data.length ? (
            <div className="py-12 text-center text-sm text-muted-foreground">No agent sessions found</div>
          ) : (
            <div>
              <div className="flex items-center justify-end gap-1.5 px-4 py-2 text-xs text-muted-foreground">
                <span>Per page:</span>
                {PAGE_SIZES.map((s) => (
                  <Button key={s} variant={limit === s ? "secondary" : "ghost"} size="xs" onClick={() => setLimit(s)}>
                    {s}
                  </Button>
                ))}
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead>Entity Key</TableHead>
                    <TableHead>Session ID</TableHead>
                    <TableHead className="text-right">Updated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.data.map((session) => {
                    const isExpanded = expandedKey === session.entityKey
                    // Use "issues" as default — GitHub redirects to /pull/ for PRs
                    const ghUrl = entityGitHubUrl(session.entityKey, "issues")
                    return (
                      <Fragment key={session.entityKey}>
                        <TableRow className="cursor-pointer" onClick={() => toggleExpand(session.entityKey)}>
                          <TableCell className="w-8 px-2">
                            {isExpanded ? (
                              <CaretDown className="size-3.5 text-muted-foreground" />
                            ) : (
                              <CaretRightIcon className="size-3.5 text-muted-foreground" />
                            )}
                          </TableCell>
                          <TableCell className="font-mono text-sm">
                            {ghUrl ? <GitHubLink href={ghUrl}>{session.entityKey}</GitHubLink> : session.entityKey}
                          </TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">
                            {session.sessionId ? `${session.sessionId.slice(0, 12)}...` : "-"}
                          </TableCell>
                          <TableCell className="text-right text-muted-foreground">
                            {formatTimeAgo(session.updatedAt)}
                          </TableCell>
                        </TableRow>
                        {isExpanded && <SessionExpandedRow entityKey={session.entityKey} />}
                      </Fragment>
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
