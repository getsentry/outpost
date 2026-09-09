import { Hono } from "hono"
import { parseOwnerRepo } from "@/lib/containers/do-prep"
import { createGitHubApp } from "@/lib/github/app"
import { nextDueAt, readSchedule, ScheduleOverlapError } from "@/lib/schedules/service"
import type { ManualRunInput, ScheduleInput } from "@/lib/schedules/validation"
import { parseManualRunInput, parseScheduleInput } from "@/lib/schedules/validation"
import { isAuthenticated } from "@/middlewares"
import type { AuthEnv } from "@/types"

const router = new Hono<AuthEnv>().use(isAuthenticated())

function runner(env: AuthEnv["Bindings"], scheduleId: string) {
  return env.ScheduleRunner.get(env.ScheduleRunner.idFromName(scheduleId))
}

async function verifyRepoAccess(env: AuthEnv["Bindings"], repo: string): Promise<boolean> {
  const parsed = parseOwnerRepo(repo)
  if (!parsed) return false
  const app = createGitHubApp({
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET,
  })
  return (await app.getRepoInstallationToken(parsed.owner, parsed.repo)) !== null
}

function publicSchedule(schedule: NonNullable<Awaited<ReturnType<typeof readSchedule>>>) {
  return {
    id: schedule.id,
    name: schedule.name,
    repo: schedule.repo,
    prompt: schedule.prompt,
    cadence: schedule.cadence,
    time: schedule.localTime,
    timezone: schedule.timezone,
    dayOfWeek: schedule.dayOfWeek ?? undefined,
    dayOfMonth: schedule.dayOfMonth ?? undefined,
    enabled: schedule.enabled,
    revision: schedule.revision,
    armedRevision: schedule.armedRevision,
    nextDueAt: schedule.nextDueAt,
  }
}

router
  .get("/", async (c) => {
    const rows = await c.env.DB.prepare(
      "SELECT * FROM scheduled_jobs WHERE archived_at IS NULL ORDER BY updated_at DESC",
    ).all<Record<string, unknown>>()
    const data = await Promise.all(
      (rows.results ?? []).map(async (row) => {
        const id = String(row.id)
        const [schedule, last, active] = await Promise.all([
          readSchedule(c.env, id),
          c.env.DB.prepare("SELECT * FROM scheduled_job_runs WHERE schedule_id = ? ORDER BY created_at DESC LIMIT 1")
            .bind(id)
            .first(),
          c.env.DB.prepare(
            "SELECT id, status FROM scheduled_job_runs WHERE schedule_id = ? AND status IN ('preparing', 'admitting', 'admitted', 'unknown_admission') LIMIT 1",
          )
            .bind(id)
            .first(),
        ])
        return schedule ? { ...publicSchedule(schedule), lastRun: last, activeRun: active } : null
      }),
    )
    return c.json({ data: data.filter(Boolean) })
  })
  .post("/", async (c) => {
    let input: ScheduleInput
    try {
      input = parseScheduleInput(await c.req.json())
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Invalid schedule" }, 400)
    }
    if (!(await verifyRepoAccess(c.env, input.repo))) {
      return c.json({ error: `Can't access ${input.repo}. Check the GitHub App installation.` }, 400)
    }
    const id = crypto.randomUUID()
    const now = Date.now()
    const next = input.enabled
      ? nextDueAt(
          {
            cadence: input.cadence,
            localTime: input.time,
            timezone: input.timezone,
            dayOfWeek: input.dayOfWeek ?? null,
            dayOfMonth: input.dayOfMonth ?? null,
          },
          now,
        )
      : null
    await c.env.DB.prepare(
      "INSERT INTO scheduled_jobs (id, name, repo, prompt, cadence, local_time, timezone, day_of_week, day_of_month, enabled, revision, next_due_at, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)",
    )
      .bind(
        id,
        input.name,
        input.repo,
        input.prompt,
        input.cadence,
        input.time,
        input.timezone,
        input.dayOfWeek ?? null,
        input.dayOfMonth ?? null,
        input.enabled ? 1 : 0,
        next,
        c.get("user").id,
        now,
        now,
      )
      .run()
    const schedule = await readSchedule(c.env, id)
    if (!schedule) return c.json({ error: "Couldn't read created schedule" }, 500)
    await runner(c.env, id).sync(id)
    const armed = await readSchedule(c.env, id)
    if (!armed) return c.json({ error: "Couldn't read created schedule" }, 500)
    return c.json({ data: publicSchedule(armed) }, 201)
  })
  .get("/:id", async (c) => {
    const schedule = await readSchedule(c.env, c.req.param("id"))
    if (!schedule || schedule.archivedAt) return c.json({ error: "Schedule not found" }, 404)
    const runs = await c.env.DB.prepare(
      "SELECT * FROM scheduled_job_runs WHERE schedule_id = ? ORDER BY created_at DESC LIMIT 100",
    )
      .bind(schedule.id)
      .all()
    return c.json({ data: publicSchedule(schedule), runs: runs.results ?? [] })
  })
  .patch("/:id", async (c) => {
    const id = c.req.param("id")
    const current = await readSchedule(c.env, id)
    if (!current || current.archivedAt) return c.json({ error: "Schedule not found" }, 404)
    let input: ScheduleInput
    try {
      input = parseScheduleInput(await c.req.json())
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Invalid schedule" }, 400)
    }
    if (!(await verifyRepoAccess(c.env, input.repo)))
      return c.json({ error: `Can't access ${input.repo}. Check the GitHub App installation.` }, 400)
    const revision = current.revision + 1
    const now = Date.now()
    const next = input.enabled
      ? nextDueAt(
          {
            cadence: input.cadence,
            localTime: input.time,
            timezone: input.timezone,
            dayOfWeek: input.dayOfWeek ?? null,
            dayOfMonth: input.dayOfMonth ?? null,
          },
          now,
        )
      : null
    await c.env.DB.prepare(
      "UPDATE scheduled_jobs SET name = ?, repo = ?, prompt = ?, cadence = ?, local_time = ?, timezone = ?, day_of_week = ?, day_of_month = ?, enabled = ?, revision = ?, next_due_at = ?, updated_at = ? WHERE id = ? AND revision = ?",
    )
      .bind(
        input.name,
        input.repo,
        input.prompt,
        input.cadence,
        input.time,
        input.timezone,
        input.dayOfWeek ?? null,
        input.dayOfMonth ?? null,
        input.enabled ? 1 : 0,
        revision,
        next,
        now,
        id,
        current.revision,
      )
      .run()
    const schedule = await readSchedule(c.env, id)
    if (!schedule || schedule.revision !== revision)
      return c.json({ error: "Schedule changed; reload and try again." }, 409)
    await runner(c.env, id).sync(id)
    const armed = await readSchedule(c.env, id)
    if (!armed) return c.json({ error: "Schedule not found" }, 404)
    return c.json({ data: publicSchedule(armed) })
  })
  .post("/:id/run", async (c) => {
    let body: ManualRunInput
    try {
      body = parseManualRunInput(await c.req.json())
    } catch {
      return c.json({ error: "Run confirmation and idempotency key are required" }, 400)
    }
    try {
      const scheduleId = c.req.param("id")
      const result = await runner(c.env, scheduleId).runNow(scheduleId, body.idempotencyKey)
      if (!result) return c.json({ error: "Schedule not found or inactive" }, 404)
      return c.json({ data: result }, 202)
    } catch (error) {
      if (error instanceof ScheduleOverlapError) return c.json({ error: error.message }, 409)
      throw error
    }
  })
  .post("/:id/:state{pause|resume}", async (c) => {
    const id = c.req.param("id")
    const current = await readSchedule(c.env, id)
    if (!current || current.archivedAt) return c.json({ error: "Schedule not found" }, 404)
    const enabled = c.req.param("state") === "resume"
    if (current.enabled === enabled) return c.json({ data: publicSchedule(current) })
    const now = Date.now()
    const revision = current.revision + 1
    const next = enabled ? nextDueAt(current, now) : null
    await c.env.DB.prepare(
      "UPDATE scheduled_jobs SET enabled = ?, revision = ?, next_due_at = ?, updated_at = ? WHERE id = ? AND revision = ?",
    )
      .bind(enabled ? 1 : 0, revision, next, now, id, current.revision)
      .run()
    const schedule = await readSchedule(c.env, id)
    if (!schedule || schedule.revision !== revision)
      return c.json({ error: "Schedule changed; reload and try again." }, 409)
    await runner(c.env, id).sync(id)
    const armed = await readSchedule(c.env, id)
    if (!armed) return c.json({ error: "Schedule not found" }, 404)
    return c.json({ data: publicSchedule(armed) })
  })
  .delete("/:id", async (c) => {
    const id = c.req.param("id")
    const current = await readSchedule(c.env, id)
    if (!current || current.archivedAt) return c.json({ error: "Schedule not found" }, 404)
    const now = Date.now()
    const result = await c.env.DB.prepare(
      "UPDATE scheduled_jobs SET enabled = 0, revision = ?, next_due_at = NULL, archived_at = ?, updated_at = ? WHERE id = ? AND revision = ?",
    )
      .bind(current.revision + 1, now, now, id, current.revision)
      .run()
    if ((result.meta.changes ?? 0) !== 1) return c.json({ error: "Schedule changed; reload and try again." }, 409)
    const schedule = await readSchedule(c.env, id)
    if (schedule) await runner(c.env, id).sync(id)
    return c.json({ ok: true })
  })

export default router
