import { ErrorMsg } from "@/components/error-msg"
import { LastUpdated } from "@/components/last-updated"
import { LoadingSkeleton } from "@/components/loading-skeleton"
import { PageSizeSelect } from "@/components/page-size-select"
import { Pagination } from "@/components/pagination"
import { showToast } from "@/components/toast"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { useApiClient } from "@/hooks/use-api"
import { useUrlPagination } from "@/hooks/use-url-pagination"
import type { CronJobRow, PaginatedCronJobs } from "@/lib/api"
import { timeAgo } from "@/lib/format"
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Clock, Loader2, Play, Plus, Trash2 } from "lucide-react"
import { useState } from "react"

export default function CronPage() {
  const client = useApiClient()
  const queryClient = useQueryClient()
  const { page, pageSize, cursor, setPageSize, nextPage, prevPage } = useUrlPagination({
    defaultPageSize: 25,
  })
  const [createDialogOpen, setCreateDialogOpen] = useState(false)

  const { data, isLoading, isFetching, dataUpdatedAt, error, refetch } = useQuery<PaginatedCronJobs>({
    queryKey: ["cron-jobs", pageSize, cursor],
    queryFn: () =>
      client!.cronJobs({
        limit: pageSize,
        cursor: cursor || undefined,
      }),
    enabled: !!client,
    placeholderData: keepPreviousData,
  })

  const toggleMutation = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      return client!.updateCronJob(id, { enabled })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cron-jobs"] })
      showToast("Cron job updated")
    },
    onError: (err) => {
      showToast(err instanceof Error ? err.message : "Failed to update cron job", "error")
    },
  })

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      return client!.deleteCronJob(id)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cron-jobs"] })
      showToast("Cron job deleted")
    },
    onError: (err) => {
      showToast(err instanceof Error ? err.message : "Failed to delete cron job", "error")
    },
  })

  const triggerMutation = useMutation({
    mutationFn: async (id: string) => {
      return client!.triggerCronJob(id)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cron-jobs"] })
      showToast("Cron job triggered")
    },
    onError: (err) => {
      showToast(err instanceof Error ? err.message : "Failed to trigger cron job", "error")
    },
  })

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-xl font-bold">Cron Jobs</h1>
        <div className="flex items-center gap-2">
          <LastUpdated dataUpdatedAt={dataUpdatedAt} isFetching={isFetching} onRefresh={() => refetch()} />
          <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="h-4 w-4" />
                New Job
              </Button>
            </DialogTrigger>
            <CreateCronJobDialog
              client={client}
              onClose={() => setCreateDialogOpen(false)}
              onSuccess={() => {
                setCreateDialogOpen(false)
                queryClient.invalidateQueries({ queryKey: ["cron-jobs"] })
              }}
            />
          </Dialog>
        </div>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Scheduled Jobs</CardTitle>
          <PageSizeSelect value={pageSize} onChange={setPageSize} />
        </CardHeader>
        <CardContent>
          {isLoading && !data ? (
            <LoadingSkeleton rows={10} />
          ) : error ? (
            <ErrorMsg msg={error.message} />
          ) : (
            <>
              <div className="space-y-2">
                {data?.jobs.map((job) => (
                  <CronJobCard
                    key={job.id}
                    job={job}
                    onToggle={(enabled) => toggleMutation.mutate({ id: job.id, enabled })}
                    onDelete={() => deleteMutation.mutate(job.id)}
                    onTrigger={() => triggerMutation.mutate(job.id)}
                    isToggling={toggleMutation.isPending}
                    isDeleting={deleteMutation.isPending}
                    isTriggering={triggerMutation.isPending}
                  />
                ))}
                {data?.jobs.length === 0 && (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    No cron jobs. Create one to schedule recurring tasks.
                  </p>
                )}
              </div>

              <Pagination
                page={page}
                hasNext={!!data?.next_cursor}
                onPrev={prevPage}
                onNext={() => data?.next_cursor && nextPage(data.next_cursor)}
              />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function CronJobCard({
  job,
  onToggle,
  onDelete,
  onTrigger,
  isToggling,
  isDeleting,
  isTriggering,
}: {
  job: CronJobRow
  onToggle: (enabled: boolean) => void
  onDelete: () => void
  onTrigger: () => void
  isToggling: boolean
  isDeleting: boolean
  isTriggering: boolean
}) {
  const isEnabled = job.enabled === 1
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)

  return (
    <div className={`rounded-lg border p-3 ${!isEnabled ? "opacity-60" : ""}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Clock className={`h-4 w-4 ${isEnabled ? "text-primary" : "text-muted-foreground"}`} />
          <span className="font-medium">{job.name}</span>
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{job.cron_expression}</code>
          <span className="text-xs text-muted-foreground">{job.timezone}</span>
          {job.run_once === 1 && (
            <span className="rounded bg-yellow-500/10 px-1.5 py-0.5 text-xs text-yellow-600">one-time</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Switch checked={isEnabled} onCheckedChange={onToggle} disabled={isToggling} />
          <Button
            variant="ghost"
            size="sm"
            onClick={onTrigger}
            disabled={isTriggering || !isEnabled}
            title="Trigger now"
          >
            {isTriggering ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          </Button>
          <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
            <DialogTrigger asChild>
              <Button variant="ghost" size="sm" disabled={isDeleting} title="Delete">
                {isDeleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Delete Cron Job</DialogTitle>
                <DialogDescription>
                  Are you sure you want to delete "{job.name}"? This action cannot be undone.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setDeleteDialogOpen(false)}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => {
                    onDelete()
                    setDeleteDialogOpen(false)
                  }}
                  disabled={isDeleting}
                >
                  {isDeleting && <Loader2 className="animate-spin" />}
                  Delete
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>
      <div className="mt-2 space-y-1">
        <p className="line-clamp-2 text-sm text-muted-foreground">{job.prompt}</p>
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span>Agent: {job.agent}</span>
          {job.entity_key && <span className="font-mono">Entity: {job.entity_key}</span>}
          {job.next_run_at && <span>Next: {timeAgo(job.next_run_at)}</span>}
          {job.last_run_at && <span>Last: {timeAgo(job.last_run_at)}</span>}
          <span>Created by: {job.created_by}</span>
        </div>
      </div>
    </div>
  )
}

function CreateCronJobDialog({
  client,
  onClose,
  onSuccess,
}: {
  client: ReturnType<typeof useApiClient>
  onClose: () => void
  onSuccess: () => void
}) {
  const [name, setName] = useState("")
  const [cronExpression, setCronExpression] = useState("")
  const [prompt, setPrompt] = useState("")
  const [agent, setAgent] = useState("jared")
  const [entityKey, setEntityKey] = useState("")
  const [timezone, setTimezone] = useState("UTC")
  const [runOnce, setRunOnce] = useState(false)
  const [error, setError] = useState("")

  const createMutation = useMutation({
    mutationFn: async () => {
      return client!.createCronJob({
        name,
        cron_expression: cronExpression,
        prompt,
        agent,
        entity_key: entityKey || null,
        timezone,
        run_once: runOnce,
      })
    },
    onSuccess: () => {
      showToast("Cron job created")
      onSuccess()
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to create cron job")
    },
  })

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError("")

    if (!name.trim()) {
      setError("Name is required")
      return
    }
    if (!cronExpression.trim()) {
      setError("Cron expression is required")
      return
    }
    if (!prompt.trim()) {
      setError("Prompt is required")
      return
    }
    if (!agent.trim()) {
      setError("Agent is required")
      return
    }

    createMutation.mutate()
  }

  return (
    <DialogContent className="max-w-lg">
      <DialogHeader>
        <DialogTitle>Create Cron Job</DialogTitle>
        <DialogDescription>Schedule a recurring task that triggers an agent prompt.</DialogDescription>
      </DialogHeader>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="name">Name</Label>
          <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="daily-triage" />
        </div>

        <div className="space-y-2">
          <Label htmlFor="cron">Cron Expression</Label>
          <Input
            id="cron"
            value={cronExpression}
            onChange={(e) => setCronExpression(e.target.value)}
            placeholder="0 9 * * MON-FRI"
          />
          <p className="text-xs text-muted-foreground">Standard cron format: minute hour day month weekday</p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="prompt">Prompt</Label>
          <Textarea
            id="prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Review all open issues and triage them..."
            rows={4}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="agent">Agent</Label>
            <Input id="agent" value={agent} onChange={(e) => setAgent(e.target.value)} placeholder="jared" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="timezone">Timezone</Label>
            <Input id="timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="UTC" />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="entityKey">Entity Key (optional)</Label>
          <Input
            id="entityKey"
            value={entityKey}
            onChange={(e) => setEntityKey(e.target.value)}
            placeholder="owner/repo#123"
          />
          <p className="text-xs text-muted-foreground">If set, the job will use session affinity for this entity.</p>
        </div>

        <div className="flex items-center gap-2">
          <Switch id="runOnce" checked={runOnce} onCheckedChange={setRunOnce} />
          <Label htmlFor="runOnce">Run once (disable after first execution)</Label>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={createMutation.isPending}>
            {createMutation.isPending && <Loader2 className="animate-spin" />}
            Create
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  )
}
