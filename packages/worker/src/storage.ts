// D1-backed lifecycle store using Drizzle ORM. Port of the SQLite-based
// store from opentower, adapted for Cloudflare D1's async API.

import { and, desc, eq, gt, lt, or, sql } from "drizzle-orm"
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1"
import * as schema from "./schema"

export const DEFAULT_RETENTION_DAYS = 30

export type EntityRow = {
  entity_key: string
  repo: string
  number: number
  kind: "issue" | "pull_request"
  session_id: string
  share_url: string | null
  cwd: string | null
  agent: string
  created_at: string
  updated_at: string
}

export type LinkRow = {
  source_key: string
  target_key: string
  relation: string
  created_at: string
}

export type DispatchRow = {
  id: string
  entity_key: string | null
  session_id: string | null
  share_url: string | null
  cwd: string | null
  trigger_name: string
  event: string
  delivery_id: string
  status: "started" | "completed" | "failed" | "timeout"
  created_at: string
  completed_at: string | null
}

export type StatsResult = {
  total_entities: number
  total_dispatches: number
  status_counts: Record<string, number>
  recent_24h: number
}

export type CronJobRow = {
  id: string
  name: string
  cron_expression: string
  prompt: string
  entity_key: string | null
  agent: string
  timezone: string
  enabled: number
  run_once: number
  created_by: string
  created_at: string
  updated_at: string
  last_run_at: string | null
  next_run_at: string | null
}

export type CronExecutionRow = {
  id: string
  cron_job_id: string
  dispatch_id: string | null
  status: "pending" | "running" | "completed" | "failed" | "skipped"
  scheduled_at: string
  started_at: string | null
  completed_at: string | null
}

export type LifecycleStore = {
  upsertEntity(
    row: Pick<EntityRow, "entity_key" | "repo" | "number" | "kind" | "session_id" | "share_url" | "cwd" | "agent">,
  ): Promise<void>
  deleteEntity(entityKey: string): Promise<void>
  resolveSession(entityKey: string, linkedIssueKeys?: string[]): Promise<EntityRow | null>

  addLink(sourceKey: string, targetKey: string, relation: string): Promise<void>

  insertDispatch(
    row: Omit<DispatchRow, "created_at" | "completed_at" | "share_url" | "cwd"> & {
      share_url?: string | null
      cwd?: string | null
    },
  ): Promise<void>
  updateDispatchSession(id: string, sessionId: string, shareUrl: string | null): Promise<void>
  completeDispatch(id: string, status: "completed" | "failed" | "timeout"): Promise<void>

  listEntities(opts?: { limit?: number; cursor?: string; repo?: string }): Promise<{
    entities: EntityRow[]
    next_cursor: string | null
  }>
  getEntity(entityKey: string): Promise<EntityRow | null>
  getEntityDispatches(entityKey: string): Promise<DispatchRow[]>
  getEntityLinks(entityKey: string): Promise<LinkRow[]>
  listDispatches(opts?: { limit?: number; cursor?: string; status?: string; event?: string }): Promise<{
    dispatches: DispatchRow[]
    next_cursor: string | null
  }>
  getStats(): Promise<StatsResult>

  createCronJob(
    job: Pick<
      CronJobRow,
      "id" | "name" | "cron_expression" | "prompt" | "entity_key" | "agent" | "timezone" | "run_once" | "created_by"
    > & { next_run_at?: string | null },
  ): Promise<void>
  updateCronJob(
    id: string,
    updates: Partial<Pick<CronJobRow, "name" | "cron_expression" | "prompt" | "entity_key" | "agent" | "timezone">> & {
      enabled?: boolean
      next_run_at?: string | null
    },
  ): Promise<void>
  deleteCronJob(id: string): Promise<void>
  getCronJob(id: string): Promise<CronJobRow | null>
  getCronJobByName(name: string): Promise<CronJobRow | null>
  listCronJobs(opts?: { limit?: number; cursor?: string; enabled?: boolean }): Promise<{
    jobs: CronJobRow[]
    next_cursor: string | null
  }>
  listEnabledCronJobs(): Promise<CronJobRow[]>
  updateCronJobLastRun(id: string, lastRunAt: string, nextRunAt: string | null): Promise<void>
  disableCronJob(id: string): Promise<void>

  insertCronExecution(row: Pick<CronExecutionRow, "id" | "cron_job_id" | "scheduled_at" | "status">): Promise<void>
  updateCronExecution(
    id: string,
    updates: Partial<Pick<CronExecutionRow, "dispatch_id" | "status" | "started_at" | "completed_at">>,
  ): Promise<void>
  listCronExecutions(jobId: string, opts?: { limit?: number }): Promise<CronExecutionRow[]>

  pruneOlderThan(days: number): Promise<{ dispatches: number; entities: number; cron_executions: number; links: number }>

  getRetentionDays(): Promise<number | null>
  setRetentionDays(days: number): Promise<void>

  // Dedup
  checkDedup(deliveryId: string): Promise<boolean>
  pruneDedup(): Promise<void>
}

function now(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19)
}

export function createLifecycleStore(d1: D1Database): LifecycleStore {
  const db: DrizzleD1Database<typeof schema> = drizzle(d1, { schema })

  return {
    async upsertEntity(row) {
      // D1 supports raw SQL for complex upserts.
      await d1
        .prepare(
          `INSERT INTO entities (entity_key, repo, number, kind, session_id, share_url, cwd, agent, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(entity_key) DO UPDATE SET
           session_id = excluded.session_id,
           share_url  = COALESCE(excluded.share_url, entities.share_url),
           cwd        = COALESCE(excluded.cwd, entities.cwd),
           kind       = CASE WHEN excluded.kind = 'pull_request' THEN 'pull_request' ELSE entities.kind END,
           agent      = excluded.agent,
           updated_at = datetime('now')`,
        )
        .bind(row.entity_key, row.repo, row.number, row.kind, row.session_id, row.share_url, row.cwd ?? null, row.agent)
        .run()
    },

    async deleteEntity(entityKey) {
      await db.delete(schema.entities).where(eq(schema.entities.entity_key, entityKey))
    },

    async resolveSession(entityKey, linkedIssueKeys) {
      const direct = await db.select().from(schema.entities).where(eq(schema.entities.entity_key, entityKey)).get()
      if (direct) return direct as EntityRow

      const asSource = await db.select().from(schema.links).where(eq(schema.links.source_key, entityKey)).all()
      for (const link of asSource) {
        const target = await db.select().from(schema.entities).where(eq(schema.entities.entity_key, link.target_key)).get()
        if (target) return target as EntityRow
      }

      const asTarget = await db.select().from(schema.links).where(eq(schema.links.target_key, entityKey)).all()
      for (const link of asTarget) {
        const source = await db
          .select()
          .from(schema.entities)
          .where(eq(schema.entities.entity_key, link.source_key))
          .get()
        if (source) return source as EntityRow
      }

      if (linkedIssueKeys && linkedIssueKeys.length > 0) {
        for (const issueKey of linkedIssueKeys) {
          const issueEntity = await db
            .select()
            .from(schema.entities)
            .where(eq(schema.entities.entity_key, issueKey))
            .get()
          if (issueEntity) return issueEntity as EntityRow
        }
      }

      return null
    },

    async addLink(sourceKey, targetKey, relation) {
      await d1
        .prepare(
          "INSERT OR IGNORE INTO links (source_key, target_key, relation, created_at) VALUES (?, ?, ?, datetime('now'))",
        )
        .bind(sourceKey, targetKey, relation)
        .run()
    },

    async insertDispatch(row) {
      await db
        .insert(schema.dispatches)
        .values({
          id: row.id,
          entity_key: row.entity_key,
          session_id: row.session_id,
          share_url: row.share_url ?? null,
          cwd: row.cwd ?? null,
          trigger_name: row.trigger_name,
          event: row.event,
          delivery_id: row.delivery_id,
          status: row.status,
          created_at: now(),
        })
    },

    async updateDispatchSession(id, sessionId, shareUrl) {
      await db
        .update(schema.dispatches)
        .set({ session_id: sessionId, share_url: shareUrl })
        .where(eq(schema.dispatches.id, id))
    },

    async completeDispatch(id, status) {
      await db.update(schema.dispatches).set({ status, completed_at: now() }).where(eq(schema.dispatches.id, id))
    },

    async listEntities(opts = {}) {
      const limit = Math.min(opts.limit ?? 50, 200)
      const conditions = []
      if (opts.cursor) {
        const parts = opts.cursor.split("|")
        const ts = parts[0]
        const key = parts[1] ?? ""
        conditions.push(
          or(
            lt(schema.entities.updated_at, ts),
            and(eq(schema.entities.updated_at, ts), lt(schema.entities.entity_key, key)),
          )!,
        )
      }
      if (opts.repo) {
        conditions.push(eq(schema.entities.repo, opts.repo))
      }
      const rows = (await db
        .select()
        .from(schema.entities)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(schema.entities.updated_at), desc(schema.entities.entity_key))
        .limit(limit + 1)
        .all()) as EntityRow[]

      const hasMore = rows.length > limit
      if (hasMore) rows.pop()
      return {
        entities: rows,
        next_cursor:
          hasMore && rows.length > 0 ? `${rows[rows.length - 1].updated_at}|${rows[rows.length - 1].entity_key}` : null,
      }
    },

    async getEntity(entityKey) {
      return (
        ((await db
          .select()
          .from(schema.entities)
          .where(eq(schema.entities.entity_key, entityKey))
          .get()) as EntityRow) ?? null
      )
    },

    async getEntityDispatches(entityKey) {
      return (await db
        .select()
        .from(schema.dispatches)
        .where(eq(schema.dispatches.entity_key, entityKey))
        .orderBy(desc(schema.dispatches.created_at))
        .all()) as DispatchRow[]
    },

    async getEntityLinks(entityKey) {
      const asSource = (await db
        .select()
        .from(schema.links)
        .where(eq(schema.links.source_key, entityKey))
        .all()) as LinkRow[]
      const asTarget = (await db
        .select()
        .from(schema.links)
        .where(eq(schema.links.target_key, entityKey))
        .all()) as LinkRow[]
      return [...asSource, ...asTarget]
    },

    async listDispatches(opts = {}) {
      const limit = Math.min(opts.limit ?? 50, 200)
      const conditions = []
      if (opts.cursor) {
        const parts = opts.cursor.split("|")
        const ts = parts[0]
        const id = parts[1] ?? ""
        conditions.push(
          or(
            lt(schema.dispatches.created_at, ts),
            and(eq(schema.dispatches.created_at, ts), lt(schema.dispatches.id, id)),
          )!,
        )
      }
      if (opts.status) {
        conditions.push(eq(schema.dispatches.status, opts.status))
      }
      if (opts.event) {
        conditions.push(eq(schema.dispatches.event, opts.event))
      }
      const rows = (await db
        .select()
        .from(schema.dispatches)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(schema.dispatches.created_at), desc(schema.dispatches.id))
        .limit(limit + 1)
        .all()) as DispatchRow[]

      const hasMore = rows.length > limit
      if (hasMore) rows.pop()
      return {
        dispatches: rows,
        next_cursor:
          hasMore && rows.length > 0 ? `${rows[rows.length - 1].created_at}|${rows[rows.length - 1].id}` : null,
      }
    },

    async getStats() {
      const totalEntities = (await db.select({ c: sql<number>`count(*)` }).from(schema.entities).get())?.c ?? 0
      const totalDispatches = (await db.select({ c: sql<number>`count(*)` }).from(schema.dispatches).get())?.c ?? 0
      const recent24h =
        (
          await db
            .select({ c: sql<number>`count(*)` })
            .from(schema.dispatches)
            .where(gt(schema.dispatches.created_at, sql`datetime('now', '-1 day')`))
            .get()
        )?.c ?? 0
      const statusRows = await db
        .select({ status: schema.dispatches.status, c: sql<number>`count(*)` })
        .from(schema.dispatches)
        .groupBy(schema.dispatches.status)
        .all()
      const statusCounts: Record<string, number> = {}
      for (const row of statusRows) statusCounts[row.status] = row.c
      return {
        total_entities: totalEntities,
        total_dispatches: totalDispatches,
        status_counts: statusCounts,
        recent_24h: recent24h,
      }
    },

    async createCronJob(job) {
      await db.insert(schema.cronJobs).values({
        id: job.id,
        name: job.name,
        cron_expression: job.cron_expression,
        prompt: job.prompt,
        entity_key: job.entity_key,
        agent: job.agent,
        timezone: job.timezone,
        run_once: job.run_once ? 1 : 0,
        created_by: job.created_by,
        next_run_at: job.next_run_at ?? null,
        created_at: now(),
        updated_at: now(),
      })
    },

    async updateCronJob(id, updates) {
      const fields: Record<string, unknown> = { updated_at: now() }
      if (updates.name !== undefined) fields.name = updates.name
      if (updates.cron_expression !== undefined) fields.cron_expression = updates.cron_expression
      if (updates.prompt !== undefined) fields.prompt = updates.prompt
      if (updates.entity_key !== undefined) fields.entity_key = updates.entity_key
      if (updates.agent !== undefined) fields.agent = updates.agent
      if (updates.timezone !== undefined) fields.timezone = updates.timezone
      if (updates.enabled !== undefined) fields.enabled = updates.enabled ? 1 : 0
      if (updates.next_run_at !== undefined) fields.next_run_at = updates.next_run_at ?? null

      if (Object.keys(fields).length <= 1) return

      await db.update(schema.cronJobs).set(fields).where(eq(schema.cronJobs.id, id))
    },

    async deleteCronJob(id) {
      await db.delete(schema.cronJobs).where(eq(schema.cronJobs.id, id))
    },

    async getCronJob(id) {
      return ((await db.select().from(schema.cronJobs).where(eq(schema.cronJobs.id, id)).get()) as CronJobRow) ?? null
    },

    async getCronJobByName(name) {
      return (
        ((await db.select().from(schema.cronJobs).where(eq(schema.cronJobs.name, name)).get()) as CronJobRow) ?? null
      )
    },

    async listCronJobs(opts = {}) {
      const limit = Math.min(opts.limit ?? 50, 200)
      const conditions = []
      if (opts.cursor) {
        const parts = opts.cursor.split("|")
        const ts = parts[0]
        const id = parts[1] ?? ""
        conditions.push(
          or(lt(schema.cronJobs.created_at, ts), and(eq(schema.cronJobs.created_at, ts), lt(schema.cronJobs.id, id)))!,
        )
      }
      if (opts.enabled !== undefined && opts.enabled !== null) {
        conditions.push(eq(schema.cronJobs.enabled, opts.enabled ? 1 : 0))
      }
      const rows = (await db
        .select()
        .from(schema.cronJobs)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(schema.cronJobs.created_at), desc(schema.cronJobs.id))
        .limit(limit + 1)
        .all()) as CronJobRow[]

      const hasMore = rows.length > limit
      if (hasMore) rows.pop()
      return {
        jobs: rows,
        next_cursor:
          hasMore && rows.length > 0 ? `${rows[rows.length - 1].created_at}|${rows[rows.length - 1].id}` : null,
      }
    },

    async listEnabledCronJobs() {
      return (await db
        .select()
        .from(schema.cronJobs)
        .where(eq(schema.cronJobs.enabled, 1))
        .all()) as CronJobRow[]
    },

    async updateCronJobLastRun(id, lastRunAt, nextRunAt) {
      await db
        .update(schema.cronJobs)
        .set({ last_run_at: lastRunAt, next_run_at: nextRunAt, updated_at: now() })
        .where(eq(schema.cronJobs.id, id))
    },

    async disableCronJob(id) {
      await db.update(schema.cronJobs).set({ enabled: 0, updated_at: now() }).where(eq(schema.cronJobs.id, id))
    },

    async insertCronExecution(row) {
      await db.insert(schema.cronExecutions).values({
        id: row.id,
        cron_job_id: row.cron_job_id,
        scheduled_at: row.scheduled_at,
        status: row.status,
      })
    },

    async updateCronExecution(id, updates) {
      const fields: Record<string, unknown> = {}
      if (updates.dispatch_id !== undefined) fields.dispatch_id = updates.dispatch_id ?? null
      if (updates.status !== undefined) fields.status = updates.status
      if (updates.started_at !== undefined) fields.started_at = updates.started_at ?? null
      if (updates.completed_at !== undefined) fields.completed_at = updates.completed_at ?? null

      if (Object.keys(fields).length === 0) return

      await db.update(schema.cronExecutions).set(fields).where(eq(schema.cronExecutions.id, id))
    },

    async listCronExecutions(jobId, opts = {}) {
      const limit = Math.min(opts.limit ?? 50, 200)
      return (await db
        .select()
        .from(schema.cronExecutions)
        .where(eq(schema.cronExecutions.cron_job_id, jobId))
        .orderBy(desc(schema.cronExecutions.scheduled_at))
        .limit(limit)
        .all()) as CronExecutionRow[]
    },

    async pruneOlderThan(days: number) {
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().replace("T", " ").slice(0, 19)

      // Use d1.batch() for transactional consistency — all deletes
      // succeed or fail together, preventing partial prune state.
      const results = await d1.batch([
        d1.prepare("DELETE FROM dispatches WHERE created_at < ? AND status NOT IN ('started')").bind(cutoff),
        d1.prepare("DELETE FROM cron_executions WHERE scheduled_at < ? AND status NOT IN ('pending', 'running')").bind(cutoff),
        d1.prepare(
          `DELETE FROM entities WHERE updated_at < ?
           AND entity_key NOT IN (SELECT DISTINCT entity_key FROM dispatches WHERE entity_key IS NOT NULL)`,
        ).bind(cutoff),
        d1.prepare(
          `DELETE FROM links WHERE source_key NOT IN (SELECT entity_key FROM entities)
           AND target_key NOT IN (SELECT entity_key FROM entities)`,
        ),
      ])

      return {
        dispatches: results[0]?.meta?.changes ?? 0,
        cron_executions: results[1]?.meta?.changes ?? 0,
        entities: results[2]?.meta?.changes ?? 0,
        links: results[3]?.meta?.changes ?? 0,
      }
    },

    async getRetentionDays() {
      const row = await db.select().from(schema.metadata).where(eq(schema.metadata.key, "retention_days")).get()
      if (!row) return null
      const n = Number(row.value)
      return Number.isFinite(n) && n > 0 ? n : null
    },

    async setRetentionDays(days: number) {
      await d1
        .prepare(
          "INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .bind("retention_days", String(days))
        .run()
    },

    async checkDedup(deliveryId: string) {
      const existing = await d1
        .prepare("SELECT delivery_id FROM dedup_entries WHERE delivery_id = ?")
        .bind(deliveryId)
        .first()
      if (existing) return true
      await d1
        .prepare("INSERT OR IGNORE INTO dedup_entries (delivery_id, created_at) VALUES (?, datetime('now'))")
        .bind(deliveryId)
        .run()
      return false
    },

    async pruneDedup() {
      await d1.prepare("DELETE FROM dedup_entries WHERE created_at < datetime('now', '-1 hour')").run()
    },
  }
}
