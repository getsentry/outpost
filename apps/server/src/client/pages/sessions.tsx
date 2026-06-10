import {
  ArrowClockwise,
  CaretDown,
  CaretLeft,
  CaretRight,
  CaretRight as CaretRightIcon,
  MagnifyingGlass,
  Robot,
  X,
} from "@phosphor-icons/react"
import { Fragment, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { GitHubLink } from "@/client/components/github-link"
import { LastUpdated } from "@/client/components/last-updated"
import { entityGitHubUrl, formatTimeAgo, parseEntityKey, repoGitHubUrl } from "@/client/lib/format"
import { useSessionDetail, useSessions } from "@/client/lib/queries"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

const PAGE_SIZES = [10, 25, 50] as const

function SessionExpandedRow({ entityKey }: { entityKey: string }) {
  const { data, isLoading, isError, isFetching, refetch, dataUpdatedAt } = useSessionDetail(entityKey)
  const [activeTab, setActiveTab] = useState<"sessions" | "messages" | "logs">("sessions")

  if (isLoading) {
    return (
      <TableRow>
        <TableCell colSpan={5} className="bg-muted/30 p-4">
          <Skeleton className="h-32 w-full" />
        </TableCell>
      </TableRow>
    )
  }

  if (isError || !data) {
    return (
      <TableRow>
        <TableCell colSpan={5} className="bg-muted/30 p-4 text-sm text-destructive">
          Failed to load session data
        </TableCell>
      </TableRow>
    )
  }

  let parsed: Record<string, unknown> = {}
  try {
    parsed = JSON.parse(data.sessionData)
  } catch {
    /* empty */
  }

  const sessions = parsed.sessions as Array<Record<string, unknown>> | undefined
  const messages = parsed.messages as Record<string, Array<Record<string, unknown>>> | undefined
  const logs = (parsed.logs as string) ?? ""
  const sessionStatus = parsed.sessionStatus as Record<string, Record<string, string>> | undefined

  return (
    <TableRow>
      <TableCell colSpan={5} className="bg-muted/30 p-0">
        <div className="w-full overflow-hidden p-4">
          {/* Tabs + refresh */}
          <div className="mb-3 flex items-center gap-1">
            {(["sessions", "messages", "logs"] as const).map((tab) => (
              <Button
                key={tab}
                variant={activeTab === tab ? "default" : "outline"}
                size="xs"
                onClick={() => setActiveTab(tab)}
              >
                {tab.charAt(0).toUpperCase() + tab.slice(1)}
              </Button>
            ))}
            <div className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
              {dataUpdatedAt ? <span>{formatTimeAgo(new Date(dataUpdatedAt).toISOString())}</span> : null}
              <Button variant="ghost" size="xs" onClick={() => refetch()} disabled={isFetching}>
                <ArrowClockwise className={`size-3 ${isFetching ? "animate-spin" : ""}`} />
              </Button>
            </div>
          </div>

          {/* Sessions tab */}
          {activeTab === "sessions" && (
            <div className="space-y-2">
              {sessions?.map((s) => {
                const id = s.id as string
                const status = sessionStatus?.[id]?.type ?? "unknown"
                const cost = typeof s.cost === "number" ? `$${s.cost.toFixed(4)}` : "-"
                const tokens = s.tokens as Record<string, number> | undefined
                const title = (s.title as string) ?? id
                const agent = (s.agent as string) ?? "-"
                const model = (s.model as Record<string, string>)?.id ?? "-"
                const parentID = s.parentID as string | undefined
                return (
                  <div
                    key={id}
                    className={`rounded border p-3 text-xs ${parentID ? "ml-4 border-l-2 border-l-muted-foreground/30" : ""}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="min-w-0 break-words font-medium">{title}</span>
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${status === "busy" ? "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200" : status === "idle" ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200" : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"}`}
                      >
                        {status}
                      </span>
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-muted-foreground">
                      <span>agent: {agent}</span>
                      <span>model: {model}</span>
                      <span>cost: {cost}</span>
                      {tokens && (
                        <span>
                          in: {tokens.input ?? 0} / out: {tokens.output ?? 0}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground/60">{id}</div>
                  </div>
                )
              })}
              {(!sessions || sessions.length === 0) && (
                <div className="py-4 text-center text-sm text-muted-foreground">No sessions found</div>
              )}
            </div>
          )}

          {/* Messages tab */}
          {activeTab === "messages" && (
            <div className="max-h-[600px] space-y-3 overflow-auto">
              {messages && Object.keys(messages).length > 0 ? (
                Object.entries(messages).map(([sessionId, msgs]) => (
                  <div key={sessionId}>
                    <div className="mb-1.5 text-xs font-medium text-muted-foreground">
                      Session: <span className="font-mono">{sessionId.slice(0, 24)}...</span>
                    </div>
                    <div className="space-y-1">
                      {Array.isArray(msgs) &&
                        msgs.map((msg, i) => {
                          const info = msg.info as Record<string, unknown> | undefined
                          const parts = msg.parts as Array<Record<string, unknown>> | undefined
                          const role = (info?.role as string) ?? "unknown"
                          return (
                            <div
                              key={i}
                              className={`overflow-hidden rounded border-l-2 p-2 text-xs ${role === "assistant" ? "border-l-blue-400 bg-blue-50/50 dark:bg-blue-950/20" : "border-l-gray-300 bg-muted/30"}`}
                            >
                              <span
                                className={`text-[10px] font-medium uppercase tracking-wide ${role === "assistant" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground"}`}
                              >
                                {role}
                              </span>
                              {parts?.map((part, j) => {
                                const type = part.type as string
                                if (type === "text") {
                                  const text = (part.text as string) ?? ""
                                  return (
                                    <pre
                                      key={j}
                                      className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed"
                                    >
                                      {text.slice(0, 3000)}
                                      {text.length > 3000 && "..."}
                                    </pre>
                                  )
                                }
                                if (type === "tool-invocation" || type === "tool-result") {
                                  return (
                                    <div
                                      key={j}
                                      className="mt-1 overflow-hidden truncate rounded bg-muted px-1.5 py-1 font-mono text-[10px]"
                                    >
                                      <span className="font-medium text-muted-foreground">{type}:</span>{" "}
                                      {(part.toolName as string) ?? JSON.stringify(part).slice(0, 300)}
                                    </div>
                                  )
                                }
                                return (
                                  <div key={j} className="mt-1 text-[10px] text-muted-foreground">
                                    [{type}]
                                  </div>
                                )
                              })}
                            </div>
                          )
                        })}
                    </div>
                  </div>
                ))
              ) : (
                <div className="py-4 text-center text-sm text-muted-foreground">No messages captured yet</div>
              )}
            </div>
          )}

          {/* Logs tab */}
          {activeTab === "logs" && (
            <pre className="max-h-[400px] overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-[11px] leading-relaxed">
              {logs || "No logs captured"}
            </pre>
          )}
        </div>
      </TableCell>
    </TableRow>
  )
}

export default function SessionsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [searchInput, setSearchInput] = useState("")
  const [expandedKey, setExpandedKey] = useState<string | null>(null)

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

  const filtered = data?.data.filter((session: { entityKey: string }) => {
    if (!searchInput) return true
    return session.entityKey.toLowerCase().includes(searchInput.toLowerCase())
  })

  const pagination = data?.pagination

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Agent Sessions</h1>
          <p className="text-sm text-muted-foreground">
            {pagination ? `${pagination.total} sessions` : "Live agent session data from containers"}
          </p>
        </div>
        <LastUpdated dataUpdatedAt={dataUpdatedAt} isFetching={isFetching} onRefresh={() => refetch()} />
      </div>

      <div className="flex items-center gap-3">
        <div className="relative flex items-center">
          <MagnifyingGlass className="absolute left-2 size-3.5 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search by entity..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="h-7 w-64 border border-input bg-background pl-7 pr-7 text-xs outline-none placeholder:text-muted-foreground focus:border-ring"
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
                <Skeleton key={i} className="h-10 w-full" />
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
              <Table className="table-fixed">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead className="w-[35%]">Entity</TableHead>
                    <TableHead className="w-[25%]">Repository</TableHead>
                    <TableHead className="w-[20%]">Status</TableHead>
                    <TableHead className="w-[15%] text-right">Updated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map(
                    (session: {
                      entityKey: string
                      updatedAt: string
                      sessionStatus?: Record<string, Record<string, string>> | null
                      sessions?: Array<Record<string, unknown>> | null
                    }) => {
                      const isExpanded = expandedKey === session.entityKey
                      const ghUrl = entityGitHubUrl(session.entityKey, "issues")
                      const parsed = parseEntityKey(session.entityKey)
                      const repoName = parsed ? `${parsed.owner}/${parsed.repo}` : null

                      const statuses = session.sessionStatus ? Object.values(session.sessionStatus) : []
                      const hasBusy = statuses.some((s) => s.type === "busy")
                      const statusLabel = hasBusy ? "busy" : statuses.length > 0 ? "idle" : "unknown"

                      const totalCost = (session.sessions ?? []).reduce(
                        (sum, s) => sum + (typeof s.cost === "number" ? s.cost : 0),
                        0,
                      )

                      return (
                        <Fragment key={session.entityKey}>
                          <TableRow
                            className="cursor-pointer"
                            onClick={() => setExpandedKey(isExpanded ? null : session.entityKey)}
                          >
                            <TableCell className="w-8 px-2">
                              {isExpanded ? (
                                <CaretDown className="size-3.5 text-muted-foreground" />
                              ) : (
                                <CaretRightIcon className="size-3.5 text-muted-foreground" />
                              )}
                            </TableCell>
                            <TableCell className="truncate font-mono text-sm">
                              {ghUrl ? <GitHubLink href={ghUrl}>{session.entityKey}</GitHubLink> : session.entityKey}
                            </TableCell>
                            <TableCell className="truncate text-muted-foreground">
                              {repoName ? <GitHubLink href={repoGitHubUrl(repoName)}>{repoName}</GitHubLink> : "-"}
                            </TableCell>
                            <TableCell>
                              <span
                                className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${statusLabel === "busy" ? "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200" : statusLabel === "idle" ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200" : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"}`}
                              >
                                {statusLabel}
                              </span>
                              {totalCost > 0 && (
                                <span className="ml-2 text-xs text-muted-foreground">${totalCost.toFixed(2)}</span>
                              )}
                            </TableCell>
                            <TableCell className="text-right text-muted-foreground">
                              {formatTimeAgo(session.updatedAt)}
                            </TableCell>
                          </TableRow>
                          {isExpanded && <SessionExpandedRow entityKey={session.entityKey} />}
                        </Fragment>
                      )
                    },
                  )}
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
