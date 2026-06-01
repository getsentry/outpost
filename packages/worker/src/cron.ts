// Cron scheduler for the Worker control plane. Instead of croner (which
// requires a persistent process), this uses Cloudflare Worker Cron Triggers.
// The Worker's scheduled() handler fires every minute and checks D1 for
// jobs that are due to run.

import { dispatchNoAffinity, dispatchToSandbox } from "./dispatch"
import { parseEntityKey } from "./entity"
import { formatError, logger } from "./logger"
import type { CronJobRow, LifecycleStore } from "./storage"
import type { Env, NormalizedTrigger } from "./types"

const MIN_INTERVAL_MS = 60 * 60 * 1000

export type CronIntervalValidation =
  | { valid: true; intervalMs: number }
  | { valid: false; intervalMs: number; error: string }

export type CronScheduler = {
  tick(): Promise<void>
  getNextRun(cronExpression: string, timezone?: string): Date | null
  validateInterval(cronExpression: string, timezone?: string): CronIntervalValidation
  triggerJob(jobId: string): Promise<boolean>
}

// Simple cron expression parser for next-run calculation.
// Supports standard 5-field cron: minute hour day month weekday.
function parseCronField(field: string, min: number, max: number): number[] {
  const values: number[] = []

  for (const part of field.split(",")) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/)
    const step = stepMatch ? parseInt(stepMatch[2], 10) : 1
    const range = stepMatch ? stepMatch[1] : part

    if (range === "*") {
      for (let i = min; i <= max; i += step) values.push(i)
    } else if (range.includes("-")) {
      const [start, end] = range.split("-").map(Number)
      for (let i = start; i <= end; i += step) values.push(i)
    } else {
      const dayNames: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 }
      const val = dayNames[range.toUpperCase()] ?? parseInt(range, 10)
      if (!isNaN(val)) values.push(val)
    }
  }

  return [...new Set(values)].sort((a, b) => a - b)
}

function getNextCronRun(expression: string, _timezone = "UTC"): Date | null {
  try {
    const parts = expression.trim().split(/\s+/)
    if (parts.length !== 5) return null

    const minutes = parseCronField(parts[0], 0, 59)
    const hours = parseCronField(parts[1], 0, 23)
    const days = parseCronField(parts[2], 1, 31)
    const months = parseCronField(parts[3], 1, 12)
    const weekdays = parseCronField(parts[4], 0, 6)

    if (!minutes.length || !hours.length || !days.length || !months.length || !weekdays.length) {
      return null
    }

    const now = new Date()
    // Search up to 1 year ahead.
    const limit = new Date(now.getTime() + 366 * 24 * 60 * 60 * 1000)

    const candidate = new Date(now)
    candidate.setUTCSeconds(0, 0)
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1)

    while (candidate < limit) {
      if (
        months.includes(candidate.getUTCMonth() + 1) &&
        (parts[2] === "*" || days.includes(candidate.getUTCDate())) &&
        (parts[4] === "*" || weekdays.includes(candidate.getUTCDay())) &&
        hours.includes(candidate.getUTCHours()) &&
        minutes.includes(candidate.getUTCMinutes())
      ) {
        return candidate
      }
      candidate.setUTCMinutes(candidate.getUTCMinutes() + 1)
    }

    return null
  } catch {
    return null
  }
}

export function makeCronScheduler(opts: {
  store: LifecycleStore
  env: Env
  ghToken: string
  defaultAgent: string
}): CronScheduler {
  const { store, env, ghToken, defaultAgent } = opts

  async function executeJob(config: CronJobRow): Promise<void> {
    const executionId = crypto.randomUUID()
    const scheduledAt = new Date().toISOString()
    const deliveryId = `cron:${config.id}:${Date.now()}`

    await store.insertCronExecution({
      id: executionId,
      cron_job_id: config.id,
      scheduled_at: scheduledAt,
      status: "running",
    })

    await store.updateCronExecution(executionId, {
      started_at: scheduledAt,
    })

    logger.info("cron job executing", {
      job_id: config.id,
      job_name: config.name,
      execution_id: executionId,
    })

    try {
      const trigger: NormalizedTrigger = {
        name: `cron:${config.name}`,
        source: "cron",
        events: ["cron"],
        action: null,
        enabled: true,
        agent: config.agent || defaultAgent,
        prompt_template: "{{ prompt }}",
        cwd: null,
        ignore_authors: [],
      }

      if (config.entity_key) {
        const entityKey = parseEntityKey(config.entity_key)
        if (entityKey) {
          await dispatchToSandbox({
            env,
            store,
            entityKey,
            trigger,
            prompt: config.prompt,
            deliveryId,
            matchedEvent: "cron",
            ghToken,
          })
        } else {
          await dispatchNoAffinity({
            env,
            store,
            trigger,
            prompt: config.prompt,
            deliveryId,
            matchedEvent: "cron",
            ghToken,
          })
        }
      } else {
        await dispatchNoAffinity({
          env,
          store,
          trigger,
          prompt: config.prompt,
          deliveryId,
          matchedEvent: "cron",
          ghToken,
        })
      }

      await store.updateCronExecution(executionId, {
        status: "completed",
        completed_at: new Date().toISOString(),
      })

      const nextRun = getNextCronRun(config.cron_expression, config.timezone)
      await store.updateCronJobLastRun(config.id, scheduledAt, nextRun?.toISOString() ?? null)

      if (config.run_once) {
        await store.disableCronJob(config.id)
        logger.info("cron job disabled after run_once", {
          job_id: config.id,
          job_name: config.name,
        })
      }

      logger.info("cron job completed", {
        job_id: config.id,
        job_name: config.name,
        execution_id: executionId,
      })
    } catch (err) {
      await store.updateCronExecution(executionId, {
        status: "failed",
        completed_at: new Date().toISOString(),
      })

      logger.error("cron job execution failed", {
        job: config.name,
        error: formatError(err),
      })
    }
  }

  return {
    async tick() {
      const enabledJobs = await store.listEnabledCronJobs()
      const now = new Date()

      for (const job of enabledJobs) {
        if (!job.next_run_at) continue
        const nextRun = new Date(job.next_run_at)
        if (nextRun <= now) {
          await executeJob(job)
        }
      }
    },

    getNextRun(cronExpression: string, timezone = "UTC"): Date | null {
      return getNextCronRun(cronExpression, timezone)
    },

    validateInterval(cronExpression: string, timezone = "UTC"): CronIntervalValidation {
      const first = getNextCronRun(cronExpression, timezone)
      if (!first) {
        return { valid: false, intervalMs: 0, error: `Invalid cron expression: "${cronExpression}"` }
      }

      // Compute second run by advancing past the first.
      const afterFirst = new Date(first.getTime() + 60_000)
      const parts = cronExpression.trim().split(/\s+/)
      if (parts.length !== 5) {
        return { valid: false, intervalMs: 0, error: `Invalid cron expression: "${cronExpression}"` }
      }

      // Simple interval estimation: find two consecutive runs.
      const minutes = parseCronField(parts[0], 0, 59)
      const hours = parseCronField(parts[1], 0, 23)

      // Estimate minimum interval from the parsed fields.
      let minIntervalMs = Number.POSITIVE_INFINITY
      if (minutes.length > 1) {
        for (let i = 1; i < minutes.length; i++) {
          minIntervalMs = Math.min(minIntervalMs, (minutes[i] - minutes[i - 1]) * 60_000)
        }
        // Wrap-around interval.
        minIntervalMs = Math.min(minIntervalMs, (60 - minutes[minutes.length - 1] + minutes[0]) * 60_000)
      } else if (hours.length > 1) {
        for (let i = 1; i < hours.length; i++) {
          minIntervalMs = Math.min(minIntervalMs, (hours[i] - hours[i - 1]) * 3_600_000)
        }
      } else {
        // Daily or less frequent.
        minIntervalMs = 24 * 3_600_000
      }

      if (minIntervalMs < MIN_INTERVAL_MS) {
        const intervalMinutes = Math.round(minIntervalMs / 60_000)
        return {
          valid: false,
          intervalMs: minIntervalMs,
          error: `Cron expression runs every ${intervalMinutes} minute(s), but the minimum allowed interval is 1 hour.`,
        }
      }

      return { valid: true, intervalMs: minIntervalMs }
    },

    async triggerJob(jobId: string): Promise<boolean> {
      const job = await store.getCronJob(jobId)
      if (!job || !job.enabled) return false
      await executeJob(job)
      return true
    },
  }
}
