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
import { zodResolver } from "@hookform/resolvers/zod"
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Clock, Loader2, Play, Plus, Trash2 } from "lucide-react"
import { useState } from "react"
import { useForm } from "react-hook-form"
import { z } from "zod"

const cronJobSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  cron_expression: z.string().trim().min(1, "Cron expression is required"),
  prompt: z.string().trim().min(1, "Prompt is required"),
  agent: z.string().trim().min(1, "Agent is required"),
  entity_key: z.string().optional(),
  timezone: z.string().min(1),
  run_once: z.boolean(),
})

type CronJobFormData = z.infer<typeof cronJobSchema>

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
            {createDialogOpen && (
              <CreateCronJobDialog
                client={client}
                onClose={() => setCreateDialogOpen(false)}
                onSuccess={() => {
                  setCreateDialogOpen(false)
                  queryClient.invalidateQueries({ queryKey: ["cron-jobs"] })
                }}
              />
            )}
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
                    isToggling={toggleMutation.isPending && toggleMutation.variables?.id === job.id}
                    isDeleting={deleteMutation.isPending && deleteMutation.variables === job.id}
                    isTriggering={triggerMutation.isPending && triggerMutation.variables === job.id}
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
  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<CronJobFormData>({
    resolver: zodResolver(cronJobSchema),
    defaultValues: {
      name: "",
      cron_expression: "",
      prompt: "",
      agent: "jared",
      entity_key: "",
      timezone: "UTC",
      run_once: false,
    },
  })
  const [serverError, setServerError] = useState("")

  const runOnce = watch("run_once")

  const createMutation = useMutation({
    mutationFn: async (data: CronJobFormData) => {
      return client!.createCronJob({
        name: data.name,
        cron_expression: data.cron_expression,
        prompt: data.prompt,
        agent: data.agent,
        entity_key: data.entity_key || null,
        timezone: data.timezone,
        run_once: data.run_once,
      })
    },
    onSuccess: () => {
      showToast("Cron job created")
      onSuccess()
    },
    onError: (err) => {
      setServerError(err instanceof Error ? err.message : "Failed to create cron job")
    },
  })

  function onSubmit(data: CronJobFormData) {
    setServerError("")
    createMutation.mutate(data)
  }

  return (
    <DialogContent className="max-w-lg">
      <DialogHeader>
        <DialogTitle>Create Cron Job</DialogTitle>
        <DialogDescription>Schedule a recurring task that triggers an agent prompt.</DialogDescription>
      </DialogHeader>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="name">Name</Label>
          <Input id="name" placeholder="daily-triage" {...register("name")} />
          {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
        </div>

        <div className="space-y-2">
          <Label htmlFor="cron_expression">Cron Expression</Label>
          <Input id="cron_expression" placeholder="0 9 * * MON-FRI" {...register("cron_expression")} />
          <p className="text-xs text-muted-foreground">Standard cron format: minute hour day month weekday</p>
          {errors.cron_expression && <p className="text-sm text-destructive">{errors.cron_expression.message}</p>}
        </div>

        <div className="space-y-2">
          <Label htmlFor="prompt">Prompt</Label>
          <Textarea
            id="prompt"
            placeholder="Review all open issues and triage them..."
            rows={4}
            {...register("prompt")}
          />
          {errors.prompt && <p className="text-sm text-destructive">{errors.prompt.message}</p>}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="agent">Agent</Label>
            <Input id="agent" placeholder="jared" {...register("agent")} />
            {errors.agent && <p className="text-sm text-destructive">{errors.agent.message}</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="timezone">Timezone</Label>
            <Input id="timezone" placeholder="UTC" {...register("timezone")} />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="entity_key">Entity Key (optional)</Label>
          <Input id="entity_key" placeholder="owner/repo#123" {...register("entity_key")} />
          <p className="text-xs text-muted-foreground">If set, the job will use session affinity for this entity.</p>
        </div>

        <div className="flex items-center gap-2">
          <Switch id="run_once" checked={runOnce} onCheckedChange={(checked) => setValue("run_once", checked)} />
          <Label htmlFor="run_once">Run once (disable after first execution)</Label>
        </div>

        {serverError && <p className="text-sm text-destructive">{serverError}</p>}

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
