// Dashboard JSON API handlers for the Worker control plane.
// Port of opentower's api.ts, adapted for async D1 operations.

import type { LifecycleStore } from "../storage"
import { DEFAULT_RETENTION_DAYS } from "../storage"
import type { CronScheduler } from "../cron"

export async function apiStatsHandler(store: LifecycleStore): Promise<Response> {
  return Response.json(await store.getStats())
}

export async function apiGetRetentionHandler(store: LifecycleStore): Promise<Response> {
  const days = (await store.getRetentionDays()) ?? DEFAULT_RETENTION_DAYS
  return Response.json({ retention_days: days })
}

export async function apiSetRetentionHandler(request: Request, store: LifecycleStore): Promise<Response> {
  const body = await request.json<{ retention_days?: unknown }>().catch((): { retention_days?: unknown } => ({}))
  const days = Number(body.retention_days)
  if (!Number.isFinite(days) || days < 1 || days > 365) {
    return Response.json({ error: "retention_days must be between 1 and 365" }, { status: 400 })
  }
  await store.setRetentionDays(Math.floor(days))
  return Response.json({ retention_days: Math.floor(days) })
}

export async function apiPruneHandler(store: LifecycleStore): Promise<Response> {
  const days = (await store.getRetentionDays()) ?? DEFAULT_RETENTION_DAYS
  const result = await store.pruneOlderThan(days)
  return Response.json({ pruned: result, retention_days: days })
}

export async function apiEntitiesHandler(request: Request, store: LifecycleStore): Promise<Response> {
  const url = new URL(request.url)
  const raw = Number(url.searchParams.get("limit"))
  const limit = Math.max(1, Math.min(Number.isFinite(raw) ? raw : 50, 200))
  const cursor = url.searchParams.get("cursor") || undefined
  const repo = url.searchParams.get("repo") || undefined
  return Response.json(await store.listEntities({ limit, cursor, repo }))
}

export async function apiEntityDetailHandler(
  request: Request,
  store: LifecycleStore,
  entityKey: string,
): Promise<Response> {
  if (!entityKey) return Response.json({ error: "missing entity key" }, { status: 400 })
  const key = decodeURIComponent(entityKey)
  const entity = await store.getEntity(key)
  if (!entity) return Response.json({ error: "entity not found" }, { status: 404 })
  const dispatches = await store.getEntityDispatches(key)
  const links = await store.getEntityLinks(key)
  return Response.json({ entity, dispatches, links })
}

export async function apiDispatchesHandler(request: Request, store: LifecycleStore): Promise<Response> {
  const url = new URL(request.url)
  const raw = Number(url.searchParams.get("limit"))
  const limit = Math.max(1, Math.min(Number.isFinite(raw) ? raw : 50, 200))
  const cursor = url.searchParams.get("cursor") || undefined
  const status = url.searchParams.get("status") || undefined
  const event = url.searchParams.get("event") || undefined
  if (status && !["started", "completed", "failed", "timeout"].includes(status)) {
    return Response.json({ error: `invalid status filter: ${status}` }, { status: 400 })
  }
  return Response.json(await store.listDispatches({ limit, cursor, status, event }))
}

// Cron API handlers.
export async function apiCronListHandler(
  request: Request,
  store: LifecycleStore,
): Promise<Response> {
  const url = new URL(request.url)
  const raw = Number(url.searchParams.get("limit"))
  const limit = Math.max(1, Math.min(Number.isFinite(raw) ? raw : 50, 200))
  const cursor = url.searchParams.get("cursor") || undefined
  const enabledParam = url.searchParams.get("enabled")
  const enabled = enabledParam === "true" ? true : enabledParam === "false" ? false : undefined
  return Response.json(await store.listCronJobs({ limit, cursor, enabled }))
}

export async function apiCronCreateHandler(
  request: Request,
  store: LifecycleStore,
  scheduler: CronScheduler,
): Promise<Response> {
  let body: {
    name?: string
    cron_expression?: string
    prompt?: string
    entity_key?: string | null
    agent?: string
    timezone?: string
    run_once?: boolean
  }
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 })
  }

  const name = typeof body.name === "string" ? body.name.trim() : ""
  if (!name) return Response.json({ error: "name is required" }, { status: 400 })

  const cron_expression = typeof body.cron_expression === "string" ? body.cron_expression.trim() : ""
  if (!cron_expression) return Response.json({ error: "cron_expression is required" }, { status: 400 })

  const timezone = typeof body.timezone === "string" ? body.timezone.trim() || "UTC" : "UTC"
  const run_once = body.run_once === true

  const nextRun = scheduler.getNextRun(cron_expression, timezone)
  if (!nextRun) return Response.json({ error: "invalid cron expression" }, { status: 400 })

  if (!run_once) {
    const intervalValidation = scheduler.validateInterval(cron_expression, timezone)
    if (!intervalValidation.valid) {
      return Response.json({ error: intervalValidation.error }, { status: 400 })
    }
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : ""
  if (!prompt) return Response.json({ error: "prompt is required" }, { status: 400 })

  const agent = typeof body.agent === "string" ? body.agent.trim() : ""
  if (!agent) return Response.json({ error: "agent is required" }, { status: 400 })

  const existing = await store.getCronJobByName(name)
  if (existing) return Response.json({ error: "a cron job with this name already exists" }, { status: 409 })

  const id = crypto.randomUUID()
  const entity_key = typeof body.entity_key === "string" ? body.entity_key.trim() || null : null

  await store.createCronJob({
    id,
    name,
    cron_expression,
    prompt,
    entity_key,
    agent,
    timezone,
    run_once: run_once ? 1 : 0,
    created_by: "user",
    next_run_at: nextRun.toISOString(),
  })

  return Response.json(
    {
      created: {
        id,
        name,
        cron_expression,
        prompt,
        entity_key,
        agent,
        timezone,
        run_once,
        next_run_at: nextRun.toISOString(),
      },
    },
    { status: 201 },
  )
}

export async function apiCronUpdateHandler(
  request: Request,
  store: LifecycleStore,
  scheduler: CronScheduler,
  id: string,
): Promise<Response> {
  if (!id) return Response.json({ error: "missing job id" }, { status: 400 })

  const existing = await store.getCronJob(id)
  if (!existing) return Response.json({ error: "cron job not found" }, { status: 404 })

  let body: {
    name?: string
    cron_expression?: string
    prompt?: string
    entity_key?: string | null
    agent?: string
    timezone?: string
    enabled?: boolean
  }
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 })
  }

  const updates: Parameters<typeof store.updateCronJob>[1] = {}

  if (typeof body.name === "string") {
    const name = body.name.trim()
    if (name && name !== existing.name) {
      const other = await store.getCronJobByName(name)
      if (other && other.id !== id) {
        return Response.json({ error: "a cron job with this name already exists" }, { status: 409 })
      }
      updates.name = name
    }
  }

  if (typeof body.cron_expression === "string") {
    const cron_expression = body.cron_expression.trim()
    if (cron_expression && cron_expression !== existing.cron_expression) {
      const tz = typeof body.timezone === "string" ? body.timezone.trim() || existing.timezone : existing.timezone
      const nextRun = scheduler.getNextRun(cron_expression, tz)
      if (!nextRun) {
        return Response.json({ error: "invalid cron expression" }, { status: 400 })
      }
      if (!existing.run_once) {
        const intervalValidation = scheduler.validateInterval(cron_expression, tz)
        if (!intervalValidation.valid) {
          return Response.json({ error: intervalValidation.error }, { status: 400 })
        }
      }
      updates.cron_expression = cron_expression
      updates.next_run_at = nextRun.toISOString()
    }
  }

  if (typeof body.prompt === "string") {
    const prompt = body.prompt.trim()
    if (prompt) updates.prompt = prompt
  }

  if (body.entity_key !== undefined) {
    updates.entity_key = typeof body.entity_key === "string" ? body.entity_key.trim() || null : null
  }

  if (typeof body.agent === "string") {
    const agent = body.agent.trim()
    if (agent) updates.agent = agent
  }

  if (typeof body.timezone === "string") {
    const newTimezone = body.timezone.trim() || "UTC"
    if (newTimezone !== existing.timezone) {
      updates.timezone = newTimezone
      const expr = updates.cron_expression ?? existing.cron_expression
      const nextRun = scheduler.getNextRun(expr, newTimezone)
      if (nextRun) updates.next_run_at = nextRun.toISOString()
    }
  }

  if (typeof body.enabled === "boolean") {
    updates.enabled = body.enabled
  }

  await store.updateCronJob(id, updates)

  const updated = await store.getCronJob(id)
  return Response.json(updated)
}

export async function apiCronGetHandler(store: LifecycleStore, id: string): Promise<Response> {
  if (!id) return Response.json({ error: "missing job id" }, { status: 400 })
  const job = await store.getCronJob(id)
  if (!job) return Response.json({ error: "cron job not found" }, { status: 404 })
  return Response.json(job)
}

export async function apiCronDeleteHandler(store: LifecycleStore, id: string): Promise<Response> {
  if (!id) return Response.json({ error: "missing job id" }, { status: 400 })
  const existing = await store.getCronJob(id)
  if (!existing) return Response.json({ error: "cron job not found" }, { status: 404 })
  await store.deleteCronJob(id)
  return Response.json({ deleted: id })
}

export async function apiCronTriggerHandler(
  store: LifecycleStore,
  scheduler: CronScheduler,
  id: string,
): Promise<Response> {
  if (!id) return Response.json({ error: "missing job id" }, { status: 400 })
  const job = await store.getCronJob(id)
  if (!job) return Response.json({ error: "cron job not found" }, { status: 404 })
  if (!job.enabled) return Response.json({ error: "cron job is disabled" }, { status: 400 })
  const triggered = await scheduler.triggerJob(id)
  if (!triggered) return Response.json({ error: "failed to trigger cron job" }, { status: 500 })
  return Response.json({ triggered: id, message: "job execution started" })
}

export async function apiCronExecutionsHandler(
  request: Request,
  store: LifecycleStore,
  id: string,
): Promise<Response> {
  if (!id) return Response.json({ error: "missing job id" }, { status: 400 })
  const job = await store.getCronJob(id)
  if (!job) return Response.json({ error: "cron job not found" }, { status: 404 })
  const url = new URL(request.url)
  const raw = Number(url.searchParams.get("limit"))
  const limit = Math.max(1, Math.min(Number.isFinite(raw) ? raw : 50, 200))
  const executions = await store.listCronExecutions(id, { limit })
  return Response.json({ executions })
}
