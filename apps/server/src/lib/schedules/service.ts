import { getSandbox } from "@cloudflare/sandbox"
import { drizzle } from "drizzle-orm/d1"
import * as dbSchema from "@/db/schema"
import { startAgentGeneration } from "@/lib/agents/lifecycle"
import { ensureSandboxReady, saveInitialSession } from "@/lib/containers/dispatch"
import { parseOwnerRepo } from "@/lib/containers/do-prep"
import { dispatchToFlueAgent, fetchFlueHistory } from "@/lib/containers/flue-dispatch"
import { isFlueHistoryBusy } from "@/lib/containers/flue-session-adapt"
import { toAgentInstanceId } from "@/lib/containers/ids"
import { SANDBOX_OPTS } from "@/lib/containers/sandbox-opts"
import { createGitHubApp } from "@/lib/github/app"
import type { BaseEnvBindings } from "@/types/env/base"
import { formatScheduledPrompt } from "./prompt"
import { nextOccurrences, type Recurrence } from "./recurrence"
import { createScheduledEntityKey } from "./run-key"

export const ACTIVE_SCHEDULE_RUN_STATUSES = ["preparing", "admitting", "admitted", "unknown_admission"] as const
const SCHEDULED_RUN_CONCURRENCY = 3
const SLOT_LEASE_MS = 2 * 60 * 60 * 1000
const UNKNOWN_ADMISSION_TIMEOUT_MS = 2 * 60 * 60 * 1000
const MAX_PRE_ADMISSION_ATTEMPTS = 3

type Env = BaseEnvBindings["Bindings"]

export type ScheduleRecord = {
  id: string
  name: string
  repo: string
  prompt: string
  cadence: "daily" | "weekly" | "monthly"
  localTime: string
  timezone: string
  dayOfWeek: number | null
  dayOfMonth: number | null
  enabled: boolean
  revision: number
  nextDueAt: number | null
  archivedAt: number | null
}

export class ScheduleOverlapError extends Error {}

function asSchedule(row: Record<string, unknown>): ScheduleRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    repo: String(row.repo),
    prompt: String(row.prompt),
    cadence: row.cadence as ScheduleRecord["cadence"],
    localTime: String(row.local_time),
    timezone: String(row.timezone),
    dayOfWeek: typeof row.day_of_week === "number" ? row.day_of_week : null,
    dayOfMonth: typeof row.day_of_month === "number" ? row.day_of_month : null,
    enabled: Boolean(row.enabled),
    revision: Number(row.revision),
    nextDueAt: typeof row.next_due_at === "number" ? row.next_due_at : null,
    archivedAt: typeof row.archived_at === "number" ? row.archived_at : null,
  }
}

function recurrence(schedule: ScheduleRecord): Recurrence {
  return {
    cadence: schedule.cadence,
    time: schedule.localTime,
    timezone: schedule.timezone,
    dayOfWeek: schedule.dayOfWeek ?? undefined,
    dayOfMonth: schedule.dayOfMonth ?? undefined,
  }
}

export function nextDueAt(
  schedule: Pick<ScheduleRecord, "cadence" | "localTime" | "timezone" | "dayOfWeek" | "dayOfMonth">,
  after: number,
): number {
  return Date.parse(nextOccurrences(recurrence(schedule as ScheduleRecord), new Date(after), 1)[0]!)
}

export async function readSchedule(env: Env, scheduleId: string): Promise<ScheduleRecord | null> {
  const row = await env.DB.prepare("SELECT * FROM scheduled_jobs WHERE id = ?")
    .bind(scheduleId)
    .first<Record<string, unknown>>()
  return row ? asSchedule(row) : null
}

async function hasActiveRun(env: Env, scheduleId: string): Promise<boolean> {
  const placeholders = ACTIVE_SCHEDULE_RUN_STATUSES.map(() => "?").join(",")
  const row = await env.DB.prepare(
    `SELECT id FROM scheduled_job_runs WHERE schedule_id = ? AND status IN (${placeholders}) LIMIT 1`,
  )
    .bind(scheduleId, ...ACTIVE_SCHEDULE_RUN_STATUSES)
    .first()
  return row !== null
}

async function acquireSlot(env: Env, runId: string, now: number): Promise<number | null> {
  const leaseExpiresAt = now + SLOT_LEASE_MS
  for (let slot = 1; slot <= SCHEDULED_RUN_CONCURRENCY; slot++) {
    const result = await env.DB.prepare(
      "UPDATE scheduled_run_slots SET run_id = ?, lease_expires_at = ? WHERE slot = ? AND (run_id IS NULL OR lease_expires_at < ?)",
    )
      .bind(runId, leaseExpiresAt, slot, now)
      .run()
    if ((result.meta.changes ?? 0) === 1) return slot
  }
  return null
}

export async function releaseSlot(env: Env, runId: string): Promise<void> {
  await env.DB.prepare("UPDATE scheduled_run_slots SET run_id = NULL, lease_expires_at = NULL WHERE run_id = ?")
    .bind(runId)
    .run()
}

/** Keep a long-running admitted turn from losing its globally reserved slot. */
export async function renewSlot(env: Env, runId: string): Promise<void> {
  await env.DB.prepare("UPDATE scheduled_run_slots SET lease_expires_at = ? WHERE run_id = ?")
    .bind(Date.now() + SLOT_LEASE_MS, runId)
    .run()
}

async function insertRun(
  env: Env,
  input: {
    id: string
    schedule: ScheduleRecord
    dedupeKey: string
    trigger: "scheduled" | "manual"
    intendedAt: number
    status: string
  },
): Promise<boolean> {
  const now = Date.now()
  const result = await env.DB.prepare(
    "INSERT OR IGNORE INTO scheduled_job_runs (id, schedule_id, schedule_revision, dedupe_key, trigger, intended_at, repo, prompt, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      input.id,
      input.schedule.id,
      input.schedule.revision,
      input.dedupeKey,
      input.trigger,
      input.intendedAt,
      input.schedule.repo,
      input.schedule.prompt,
      input.status,
      now,
      now,
    )
    .run()
  return (result.meta.changes ?? 0) === 1
}

async function existingRun(
  env: Env,
  scheduleId: string,
  dedupeKey: string,
): Promise<{ runId: string; status: string } | null> {
  const row = await env.DB.prepare("SELECT id, status FROM scheduled_job_runs WHERE schedule_id = ? AND dedupe_key = ?")
    .bind(scheduleId, dedupeKey)
    .first<{ id: string; status: string }>()
  return row ? { runId: row.id, status: row.status } : null
}

async function advanceScheduleDue(env: Env, schedule: ScheduleRecord, intendedAt: number): Promise<void> {
  const next = nextDueAt(schedule, intendedAt)
  await env.DB.prepare(
    "UPDATE scheduled_jobs SET next_due_at = ?, updated_at = ? WHERE id = ? AND revision = ? AND enabled = 1 AND next_due_at = ?",
  )
    .bind(next, Date.now(), schedule.id, schedule.revision, intendedAt)
    .run()
}

/** Claim and start one occurrence. The unique due key makes at-least-once alarms safe. */
export async function startScheduleRun(
  env: Env,
  scheduleId: string,
  input: { trigger: "scheduled" | "manual"; intendedAt?: number; dedupeKey?: string } = { trigger: "scheduled" },
): Promise<{ runId: string; status: string } | null> {
  const schedule = await readSchedule(env, scheduleId)
  if (!schedule?.enabled || schedule.archivedAt || schedule.nextDueAt === null) return null

  const intendedAt = input.intendedAt ?? schedule.nextDueAt
  const dedupeKey = input.dedupeKey ?? `due:${intendedAt}`
  const runId = crypto.randomUUID()

  if (await hasActiveRun(env, scheduleId)) {
    if (input.trigger === "manual") throw new ScheduleOverlapError("This schedule already has an active run")
    const created = await insertRun(env, {
      id: runId,
      schedule,
      dedupeKey,
      trigger: input.trigger,
      intendedAt,
      status: "skipped_overlap",
    })
    if (!created) return existingRun(env, schedule.id, dedupeKey)
    await advanceScheduleDue(env, schedule, intendedAt)
    return { runId, status: "skipped_overlap" }
  }

  if (
    !(await insertRun(env, { id: runId, schedule, dedupeKey, trigger: input.trigger, intendedAt, status: "preparing" }))
  ) {
    return existingRun(env, schedule.id, dedupeKey)
  }
  if (input.trigger === "scheduled") await advanceScheduleDue(env, schedule, intendedAt)

  const slot = await acquireSlot(env, runId, Date.now())
  if (slot === null) {
    await env.DB.prepare("UPDATE scheduled_job_runs SET status = 'skipped_capacity', updated_at = ? WHERE id = ?")
      .bind(Date.now(), runId)
      .run()
    return { runId, status: "skipped_capacity" }
  }

  const entityKey = createScheduledEntityKey(schedule.repo, runId)
  for (let attempt = 1; attempt <= MAX_PRE_ADMISSION_ATTEMPTS; attempt++) {
    let phase: "preparing" | "admitting" = "preparing"
    try {
      await env.DB.prepare(
        "UPDATE scheduled_job_runs SET entity_key = ?, status = 'preparing', attempts = ?, started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?",
      )
        .bind(entityKey, attempt, Date.now(), Date.now(), runId)
        .run()
      const parsed = parseOwnerRepo(schedule.repo)
      if (!parsed) throw new Error("invalid repository")
      const app = createGitHubApp({
        appId: env.GITHUB_APP_ID,
        privateKey: env.GITHUB_APP_PRIVATE_KEY,
        webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET,
      })
      const [installationToken, botLogin] = await Promise.all([
        app.getRepoInstallationToken(parsed.owner, parsed.repo),
        app.getBotLogin(),
      ])
      if (!installationToken) throw new Error("GitHub App cannot access this repository")

      const db = drizzle(env.DB, { schema: dbSchema })
      await Promise.all([saveInitialSession(db, entityKey), startAgentGeneration(db, toAgentInstanceId(entityKey))])
      const sandbox = getSandbox(env.Sandbox, toAgentInstanceId(entityKey), SANDBOX_OPTS)
      const { resolveFlueInternalToken } = await import("@/middlewares/flue-auth")
      await ensureSandboxReady(sandbox, {
        repo: schedule.repo,
        botLogin,
        installationToken,
        entityKey,
        openrouterApiKey: env.OPENROUTER_API_KEY,
        anthropicApiKey: env.ANTHROPIC_API_KEY,
        openaiApiKey: env.OPENAI_API_KEY,
        appUrl: env.APP_URL,
        thinSandbox: env.FLUE_NATIVE === "1" || env.FLUE_NATIVE === "true",
        loreGatewayUrl: env.LORE_GATEWAY_URL,
        flueInternalToken: (await resolveFlueInternalToken(env)) ?? undefined,
      })

      phase = "admitting"
      const admission = await env.DB.prepare(
        "UPDATE scheduled_job_runs SET status = 'admitting', updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM scheduled_jobs WHERE id = ? AND revision = ? AND enabled = 1 AND archived_at IS NULL)",
      )
        .bind(Date.now(), runId, schedule.id, schedule.revision)
        .run()
      if ((admission.meta.changes ?? 0) !== 1) {
        await env.DB.prepare(
          "UPDATE scheduled_job_runs SET status = 'superseded', failure_reason = 'Schedule changed before admission', updated_at = ? WHERE id = ?",
        )
          .bind(Date.now(), runId)
          .run()
        await releaseSlot(env, runId)
        return { runId, status: "superseded" }
      }
      const admitted = await dispatchToFlueAgent(env, {
        entityKey,
        prompt: formatScheduledPrompt({
          runId,
          scheduleName: schedule.name,
          repo: schedule.repo,
          intendedAt: new Date(intendedAt).toISOString(),
          text: schedule.prompt,
        }),
      })
      await env.DB.prepare(
        "UPDATE scheduled_job_runs SET status = 'admitted', flue_submission_id = ?, admitted_at = ?, updated_at = ? WHERE id = ?",
      )
        .bind(admitted.submissionId ?? null, Date.now(), Date.now(), runId)
        .run()
      return { runId, status: "admitted" }
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 300).replace(/\s+/g, " ") : "Scheduled run failed"
      if (phase === "preparing" && attempt < MAX_PRE_ADMISSION_ATTEMPTS) {
        await env.DB.prepare("UPDATE scheduled_job_runs SET failure_reason = ?, updated_at = ? WHERE id = ?")
          .bind(message, Date.now(), runId)
          .run()
        continue
      }
      const status = phase === "admitting" ? "unknown_admission" : "failed"
      await env.DB.prepare("UPDATE scheduled_job_runs SET status = ?, failure_reason = ?, updated_at = ? WHERE id = ?")
        .bind(status, message, Date.now(), runId)
        .run()
      if (status === "failed") await releaseSlot(env, runId)
      return { runId, status }
    }
  }
  return null
}

/** Mark admitted turns settled only after the live Flue history says they are no longer busy. */
export async function settleScheduleRuns(env: Env, scheduleId: string): Promise<number> {
  const rows = await env.DB.prepare(
    "SELECT id, entity_key, status, created_at FROM scheduled_job_runs WHERE schedule_id = ? AND status IN ('admitted', 'unknown_admission') ORDER BY admitted_at LIMIT 10",
  )
    .bind(scheduleId)
    .all<{ id: string; entity_key: string | null; status: "admitted" | "unknown_admission"; created_at: number }>()
  let settled = 0
  for (const row of rows.results ?? []) {
    if (row.status === "unknown_admission" && Date.now() - row.created_at >= UNKNOWN_ADMISSION_TIMEOUT_MS) {
      const result = await env.DB.prepare(
        "UPDATE scheduled_job_runs SET status = 'needs_attention', failure_reason = COALESCE(failure_reason, 'Flue admission could not be confirmed'), updated_at = ? WHERE id = ? AND status = 'unknown_admission'",
      )
        .bind(Date.now(), row.id)
        .run()
      if ((result.meta.changes ?? 0) === 1) await releaseSlot(env, row.id)
      continue
    }
    if (!row.entity_key) continue
    const history = await fetchFlueHistory(env, row.entity_key).catch(() => null)
    if (!history || isFlueHistoryBusy(history)) continue
    const result = await env.DB.prepare(
      "UPDATE scheduled_job_runs SET status = 'settled', settled_at = ?, updated_at = ? WHERE id = ? AND status IN ('admitted', 'unknown_admission')",
    )
      .bind(Date.now(), Date.now(), row.id)
      .run()
    if ((result.meta.changes ?? 0) === 1) {
      settled++
      await releaseSlot(env, row.id)
    }
  }
  return settled
}
