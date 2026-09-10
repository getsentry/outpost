import { Archive, Clock, Play, Plus, Repeat } from "@phosphor-icons/react"
import { useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import type { Schedule, ScheduleCadence, ScheduleInput } from "@/client/lib/api"
import {
  useArchiveSchedule,
  useChatRepos,
  useCreateSchedule,
  useRunSchedule,
  useSchedule,
  useSchedules,
  useSetScheduleEnabled,
  useUpdateSchedule,
} from "@/client/lib/queries"
import { StatusBadge } from "@/components/status-badge"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { nextOccurrences } from "@/lib/schedules/recurrence"

const SECURITY_TEMPLATE =
  "Review this repository for dependency and security vulnerabilities. If fixes are needed, update one existing Jared PR or create one new PR that consolidates the safe fixes. Validate the change and summarize any blocker. Do not create a PR if there is nothing actionable."

const emptyInput = (): ScheduleInput => ({
  name: "",
  repo: "",
  prompt: "",
  cadence: "weekly",
  time: "09:00",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  dayOfWeek: 1,
  enabled: true,
})

function cadenceLabel(schedule: Pick<ScheduleInput, "cadence" | "time" | "timezone" | "dayOfWeek" | "dayOfMonth">) {
  if (schedule.cadence === "daily") return `Daily at ${schedule.time}`
  if (schedule.cadence === "weekly")
    return `Weekly on ${["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][schedule.dayOfWeek ?? 1]} at ${schedule.time}`
  return `Monthly on day ${schedule.dayOfMonth ?? 1} at ${schedule.time}`
}

function formatAt(value: number | null | undefined, timeZone?: string) {
  return value
    ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short", timeZone })
    : "Not scheduled"
}

function ScheduleEditor({
  schedule,
  open,
  onOpenChange,
}: {
  schedule: Schedule | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const create = useCreateSchedule()
  const update = useUpdateSchedule()
  const repos = useChatRepos(open)
  const [input, setInput] = useState<ScheduleInput>(schedule ?? emptyInput())
  const mutation = schedule ? update : create
  const set = <K extends keyof ScheduleInput>(key: K, value: ScheduleInput[K]) =>
    setInput((current) => ({ ...current, [key]: value }))
  const preview = useMemo(() => {
    try {
      return nextOccurrences(
        {
          cadence: input.cadence,
          time: input.time,
          timezone: input.timezone,
          dayOfWeek: input.dayOfWeek,
          dayOfMonth: input.dayOfMonth,
        },
        new Date(),
        3,
      )
    } catch {
      return []
    }
  }, [input])
  const canSubmit =
    input.name.trim() && input.repo.trim() && input.prompt.trim() && preview.length === 3 && !mutation.isPending

  const reset = () => {
    mutation.reset()
    setInput(schedule ?? emptyInput())
  }
  const submit = () => {
    if (!canSubmit) return
    const payload = { ...input, name: input.name.trim(), repo: input.repo.trim(), prompt: input.prompt.trim() }
    if (schedule) update.mutate({ id: schedule.id, input: payload }, { onSuccess: () => onOpenChange(false) })
    else create.mutate(payload, { onSuccess: () => onOpenChange(false) })
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) reset()
        onOpenChange(next)
      }}
    >
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{schedule ? "Edit schedule" : "New schedule"}</SheetTitle>
          <SheetDescription>
            Jared follows this prompt on the selected repository. The prompt decides whether it reports, opens a PR, or
            takes another action.
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-5 p-4 pt-0">
          <FieldGroup>
            <Field>
              <FieldLabel>Name</FieldLabel>
              <Input
                value={input.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder="Weekly dependency maintenance"
              />
            </Field>
            <Field>
              <FieldLabel>Repository</FieldLabel>
              <Select value={input.repo || null} onValueChange={(value) => set("repo", (value as string) ?? "")}>
                <SelectTrigger className="w-full">
                  <SelectValue
                    placeholder={repos.isLoading ? "Loading repositories…" : "Choose an installed repository"}
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {(repos.data?.repos ?? []).map((repo) => (
                      <SelectItem key={repo} value={repo}>
                        {repo}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <Input
                className="mt-2"
                value={input.repo}
                onChange={(e) => set("repo", e.target.value)}
                placeholder="or enter owner/repository"
              />
              <FieldDescription>The server verifies GitHub App access before saving.</FieldDescription>
            </Field>
            <Field>
              <div className="flex items-center justify-between">
                <FieldLabel>Prompt</FieldLabel>
                <Select onValueChange={(value) => value === "security" && set("prompt", SECURITY_TEMPLATE)}>
                  <SelectTrigger className="h-7 w-32 text-[11px]">
                    <SelectValue placeholder="Template" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="security">Security maintenance</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Textarea
                rows={8}
                value={input.prompt}
                onChange={(e) => set("prompt", e.target.value)}
                placeholder="Review open pull requests and report any risks…"
              />
              <FieldDescription>{input.prompt.length.toLocaleString()} / 20,000 characters</FieldDescription>
            </Field>
          </FieldGroup>
          <FieldGroup>
            <Field>
              <FieldLabel>Repeats</FieldLabel>
              <Select
                value={input.cadence}
                onValueChange={(value) => {
                  const cadence = value as ScheduleCadence
                  setInput((current) => ({
                    ...current,
                    cadence,
                    dayOfWeek: cadence === "weekly" ? (current.dayOfWeek ?? 1) : undefined,
                    dayOfMonth: cadence === "monthly" ? (current.dayOfMonth ?? 1) : undefined,
                  }))
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="monthly">Monthly</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            {input.cadence === "weekly" && (
              <Field>
                <FieldLabel>Day</FieldLabel>
                <Select value={String(input.dayOfWeek ?? 1)} onValueChange={(value) => set("dayOfWeek", Number(value))}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map(
                      (day, index) => (
                        <SelectItem key={day} value={String(index + 1)}>
                          {day}
                        </SelectItem>
                      ),
                    )}
                  </SelectContent>
                </Select>
              </Field>
            )}
            {input.cadence === "monthly" && (
              <Field>
                <FieldLabel>Day of month</FieldLabel>
                <Input
                  type="number"
                  min="1"
                  max="31"
                  value={input.dayOfMonth ?? 1}
                  onChange={(e) => set("dayOfMonth", Number(e.target.value))}
                />
                <FieldDescription>Short months use their final day.</FieldDescription>
              </Field>
            )}
            <Field>
              <FieldLabel>Local time</FieldLabel>
              <Input type="time" value={input.time} onChange={(e) => set("time", e.target.value)} />
            </Field>
            <Field>
              <FieldLabel>Timezone</FieldLabel>
              <Input
                list="schedule-timezones"
                value={input.timezone}
                onChange={(e) => set("timezone", e.target.value)}
              />
              <datalist id="schedule-timezones">
                <option value="UTC" />
                <option value="Asia/Kolkata" />
                <option value="America/New_York" />
                <option value="America/Los_Angeles" />
                <option value="Europe/London" />
              </datalist>
            </Field>
            <Field>
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={input.enabled} onChange={(e) => set("enabled", e.target.checked)} />{" "}
                Enable after saving
              </label>
            </Field>
          </FieldGroup>
          <Card className="bg-muted/30">
            <CardHeader>
              <CardTitle className="text-xs">Next three runs</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-xs text-muted-foreground">
              {preview.length ? (
                preview.map((time) => (
                  <p key={time}>
                    {new Date(time).toLocaleString(undefined, {
                      dateStyle: "medium",
                      timeStyle: "short",
                      timeZone: input.timezone,
                    })}
                  </p>
                ))
              ) : (
                <p>Enter a valid timezone and recurrence.</p>
              )}
            </CardContent>
          </Card>
          {mutation.isError && (
            <p role="alert" className="text-xs text-destructive">
              {mutation.error instanceof Error ? mutation.error.message : "Could not save schedule"}
            </p>
          )}
        </div>
        <SheetFooter className="border-t">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!canSubmit} onClick={submit}>
            {mutation.isPending && <Spinner data-icon="inline-start" />}
            {schedule ? "Save changes" : "Create schedule"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

function ScheduleHistory({
  scheduleId,
  open,
  onOpenChange,
}: {
  scheduleId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const detail = useSchedule(scheduleId)
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Schedule history</SheetTitle>
          <SheetDescription>
            Each entry preserves the prompt and repository Jared received for that occurrence.
          </SheetDescription>
        </SheetHeader>
        {detail.isLoading ? (
          <div className="p-6">
            <Spinner />
          </div>
        ) : detail.isError ? (
          <p className="p-6 text-sm text-destructive">Could not load run history.</p>
        ) : (
          <div className="space-y-4 p-4">
            <Card className="bg-muted/30">
              <CardContent className="space-y-2 py-4 text-xs">
                <p>
                  <span className="text-muted-foreground">Current repository:</span> {detail.data?.data.repo}
                </p>
                <p>
                  <span className="text-muted-foreground">Current prompt:</span> {detail.data?.data.prompt}
                </p>
              </CardContent>
            </Card>
            {!detail.data?.runs.length ? (
              <p className="py-8 text-center text-sm text-muted-foreground">No runs yet.</p>
            ) : (
              detail.data.runs.map((run) => (
                <Card key={run.id}>
                  <CardContent className="space-y-2 py-4 text-xs">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium">{run.status}</span>
                      <span className="text-muted-foreground">{formatAt(run.intended_at)}</span>
                    </div>
                    <p className="text-muted-foreground">
                      {run.trigger === "manual" ? "Started manually" : "Scheduled occurrence"} · {run.repo}
                    </p>
                    <p className="whitespace-pre-wrap">{run.prompt}</p>
                    {run.failure_reason && <p className="text-destructive">{run.failure_reason}</p>}
                    {run.artifact_url && (
                      <a href={run.artifact_url} target="_blank" rel="noreferrer" className="underline">
                        Open {run.artifact_kind ?? "artifact"}
                      </a>
                    )}
                    {run.entity_key && (
                      <a
                        href={`/containers/detail?key=${encodeURIComponent(run.entity_key)}`}
                        className="ml-3 underline"
                      >
                        View transcript
                      </a>
                    )}
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

export default function SchedulesPage() {
  const navigate = useNavigate()
  const schedules = useSchedules()
  const run = useRunSchedule()
  const setEnabled = useSetScheduleEnabled()
  const archive = useArchiveSchedule()
  const [editor, setEditor] = useState<Schedule | null | undefined>(undefined)
  const [historyId, setHistoryId] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{ kind: "run" | "archive"; schedule: Schedule } | null>(null)
  const actionError = [run, setEnabled, archive].find((mutation) => mutation.isError)?.error

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Schedules</h1>
          <p className="text-sm text-muted-foreground">
            Run Jared prompts on a repository at a predictable local time.
          </p>
        </div>
        <Button size="sm" onClick={() => setEditor(null)}>
          <Plus data-icon="inline-start" />
          New schedule
        </Button>
      </div>
      {schedules.isLoading ? (
        <div className="flex items-center gap-2 py-12 text-sm text-muted-foreground">
          <Spinner />
          Loading schedules…
        </div>
      ) : schedules.isError ? (
        <Card>
          <CardContent className="py-10 text-sm text-destructive">
            {schedules.error instanceof Error ? schedules.error.message : "Failed to load schedules"}
          </CardContent>
        </Card>
      ) : !schedules.data?.data.length ? (
        <Card>
          <CardContent className="py-14 text-center">
            <Repeat className="mx-auto mb-3 size-8 text-muted-foreground/60" />
            <p className="text-sm font-medium">No schedules yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Create a recurring prompt for maintenance, review, reporting, or any other repository task.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {actionError && (
            <Card>
              <CardContent role="alert" className="py-3 text-xs text-destructive">
                {actionError instanceof Error ? actionError.message : "Could not update schedule"}
              </CardContent>
            </Card>
          )}
          {schedules.data.data.map((schedule) => (
            <Card key={schedule.id}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <CardTitle className="text-sm">{schedule.name}</CardTitle>
                    <CardDescription>
                      {schedule.repo} · {cadenceLabel(schedule)} · {schedule.timezone}
                    </CardDescription>
                  </div>
                  <StatusBadge status={schedule.activeRun ? "running" : schedule.enabled ? "completed" : "skipped"} />
                </div>
              </CardHeader>
              <CardContent className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <Clock className="size-3.5" />
                  Next: {formatAt(schedule.nextDueAt, schedule.timezone)}
                </span>
                <span>Last: {schedule.lastRun ? schedule.lastRun.status : "Never"}</span>
                {schedule.enabled && schedule.armedRevision !== schedule.revision && (
                  <span className="text-amber-700 dark:text-amber-400">Scheduler recovery pending</span>
                )}
                {schedule.lastRun?.artifact_url && (
                  <a
                    className="underline underline-offset-2"
                    href={schedule.lastRun.artifact_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open {schedule.lastRun.artifact_kind ?? "artifact"}
                  </a>
                )}
                {schedule.lastRun?.entity_key && (
                  <button
                    type="button"
                    className="underline underline-offset-2"
                    onClick={() =>
                      navigate(`/containers/detail?key=${encodeURIComponent(schedule.lastRun!.entity_key!)}`)
                    }
                  >
                    View run
                  </button>
                )}
                <div className="ml-auto flex gap-2">
                  <Button variant="ghost" size="xs" onClick={() => setHistoryId(schedule.id)}>
                    History
                  </Button>
                  <Button variant="ghost" size="xs" onClick={() => setEditor(schedule)}>
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => setEnabled.mutate({ id: schedule.id, enabled: !schedule.enabled })}
                    disabled={setEnabled.isPending}
                  >
                    {schedule.enabled ? "Pause" : "Resume"}
                  </Button>
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => setConfirm({ kind: "run", schedule })}
                    disabled={!!schedule.activeRun || run.isPending}
                  >
                    <Play data-icon="inline-start" />
                    Run now
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => setConfirm({ kind: "archive", schedule })}
                    disabled={archive.isPending}
                  >
                    <Archive />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      <ScheduleEditor
        key={editor?.id ?? "new"}
        schedule={editor ?? null}
        open={editor !== undefined}
        onOpenChange={(open) => !open && setEditor(undefined)}
      />
      <ScheduleHistory
        scheduleId={historyId}
        open={historyId !== null}
        onOpenChange={(open) => !open && setHistoryId(null)}
      />
      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.kind === "run" ? `Run “${confirm.schedule.name}” now?` : `Archive “${confirm?.schedule.name}”?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.kind === "run"
                ? `Jared will run the current prompt on ${confirm.schedule.repo}. This does not change the next scheduled occurrence.`
                : "This stops future runs but keeps immutable history."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={confirm?.kind === "run" ? run.isPending : archive.isPending}
              onClick={(event) => {
                event.preventDefault()
                if (!confirm) return
                const done = () => setConfirm(null)
                if (confirm.kind === "run") run.mutate(confirm.schedule.id, { onSettled: done })
                else archive.mutate(confirm.schedule.id, { onSettled: done })
              }}
            >
              {confirm?.kind === "run" ? "Run now" : "Archive schedule"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
