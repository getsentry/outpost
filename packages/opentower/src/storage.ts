// SQLite-backed lifecycle store using Drizzle ORM. Tracks entity→session
// mappings so the same opencode session can be reused across the full
// lifecycle of an issue or PR — even across container restarts and
// issue→PR transitions.

import { Database } from "bun:sqlite"
import { existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { and, desc, eq, gt, lt, or, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { runMigrations } from "./migrations"
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
  ): void
  deleteEntity(entityKey: string): void
  resolveSession(entityKey: string, linkedIssueKeys?: string[]): EntityRow | null

  addLink(sourceKey: string, targetKey: string, relation: string): void

  insertDispatch(
    row: Omit<DispatchRow, "created_at" | "completed_at" | "share_url" | "cwd"> & {
      share_url?: string | null
      cwd?: string | null
    },
  ): void
  updateDispatchSession(id: string, sessionId: string, shareUrl: string | null): void
  completeDispatch(id: string, status: "completed" | "failed" | "timeout"): void

  listEntities(opts?: { limit?: number; cursor?: string; repo?: string }): {
    entities: EntityRow[]
    next_cursor: string | null
  }
  getEntity(entityKey: string): EntityRow | null
  getEntityDispatches(entityKey: string): DispatchRow[]
  getEntityLinks(entityKey: string): LinkRow[]
  listDispatches(opts?: { limit?: number; cursor?: string; status?: string; event?: string }): {
    dispatches: DispatchRow[]
    next_cursor: string | null
  }
  getStats(): StatsResult

  createCronJob(
    job: Pick<
      CronJobRow,
      "id" | "name" | "cron_expression" | "prompt" | "entity_key" | "agent" | "timezone" | "run_once" | "created_by"
    > & { next_run_at?: string | null },
  ): void
  updateCronJob(
    id: string,
    updates: Partial<Pick<CronJobRow, "name" | "cron_expression" | "prompt" | "entity_key" | "agent" | "timezone">> & {
      enabled?: boolean
      next_run_at?: string | null
    },
  ): void
  deleteCronJob(id: string): void
  getCronJob(id: string): CronJobRow | null
  getCronJobByName(name: string): CronJobRow | null
  listCronJobs(opts?: { limit?: number; cursor?: string; enabled?: boolean }): {
    jobs: CronJobRow[]
    next_cursor: string | null
  }
  listEnabledCronJobs(): CronJobRow[]
  updateCronJobLastRun(id: string, lastRunAt: string, nextRunAt: string | null): void
  disableCronJob(id: string): void

  insertCronExecution(row: Pick<CronExecutionRow, "id" | "cron_job_id" | "scheduled_at" | "status">): void
  updateCronExecution(
    id: string,
    updates: Partial<Pick<CronExecutionRow, "dispatch_id" | "status" | "started_at" | "completed_at">>,
  ): void
  listCronExecutions(jobId: string, opts?: { limit?: number }): CronExecutionRow[]

  pruneOlderThan(days: number): { dispatches: number; entities: number; cron_executions: number; links: number }

  getRetentionDays(): number | null
  setRetentionDays(days: number): void

  close(): void
}

function now(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19)
}

export function openLifecycleStore(dbPath: string): LifecycleStore {
  const dir = dirname(dbPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const sqlite = new Database(dbPath)
  sqlite.exec("PRAGMA journal_mode = WAL")
  sqlite.exec("PRAGMA busy_timeout = 5000")
  sqlite.exec("PRAGMA foreign_keys = ON")

  // Run migrations — creates tables if new, applies pending migrations
  // if upgrading. Safe to call on every startup.
  runMigrations(sqlite)

  const db = drizzle(sqlite, { schema })

  // Some methods use raw sqlite.prepare() instead of Drizzle:
  //   - upsertEntity: COALESCE/CASE WHEN in ON CONFLICT not expressible in Drizzle
  //   - addLink: INSERT OR IGNORE not expressible in Drizzle for composite PKs
  //   - pruneOlderThan: bulk transactional deletes with subqueries, cleaner in raw SQL
  //   - setRetentionDays: simple upsert, kept raw for consistency with getRetentionDays
  //
  // Timestamps: raw SQL uses datetime('now') (SQLite clock, UTC). Drizzle
  // .values() calls use the JS now() helper which produces the same
  // "YYYY-MM-DD HH:MM:SS" format in UTC. Both are equivalent when the
  // process runs with TZ=UTC (the default in the Docker container).
  return {
    upsertEntity(row) {
      sqlite
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
        .run(row.entity_key, row.repo, row.number, row.kind, row.session_id, row.share_url, row.cwd ?? null, row.agent)
    },

    deleteEntity(entityKey) {
      db.delete(schema.entities).where(eq(schema.entities.entity_key, entityKey)).run()
    },

    resolveSession(entityKey, linkedIssueKeys) {
      const direct = db.select().from(schema.entities).where(eq(schema.entities.entity_key, entityKey)).get()
      if (direct) return direct as EntityRow

      // Check links where this entity is the source
      const asSource = db.select().from(schema.links).where(eq(schema.links.source_key, entityKey)).all()
      for (const link of asSource) {
        const target = db.select().from(schema.entities).where(eq(schema.entities.entity_key, link.target_key)).get()
        if (target) return target as EntityRow
      }

      // Check links where this entity is the target
      const asTarget = db.select().from(schema.links).where(eq(schema.links.target_key, entityKey)).all()
      for (const link of asTarget) {
        const source = db.select().from(schema.entities).where(eq(schema.entities.entity_key, link.source_key)).get()
        if (source) return source as EntityRow
      }

      // Check linked issue keys from PR body
      if (linkedIssueKeys && linkedIssueKeys.length > 0) {
        for (const issueKey of linkedIssueKeys) {
          const issueEntity = db.select().from(schema.entities).where(eq(schema.entities.entity_key, issueKey)).get()
          if (issueEntity) return issueEntity as EntityRow
        }
      }

      return null
    },

    addLink(sourceKey, targetKey, relation) {
      sqlite
        .prepare(
          "INSERT OR IGNORE INTO links (source_key, target_key, relation, created_at) VALUES (?, ?, ?, datetime('now'))",
        )
        .run(sourceKey, targetKey, relation)
    },

    insertDispatch(row) {
      db.insert(schema.dispatches)
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
        .run()
    },

    updateDispatchSession(id, sessionId, shareUrl) {
      db.update(schema.dispatches)
        .set({ session_id: sessionId, share_url: shareUrl })
        .where(eq(schema.dispatches.id, id))
        .run()
    },

    completeDispatch(id, status) {
      db.update(schema.dispatches).set({ status, completed_at: now() }).where(eq(schema.dispatches.id, id)).run()
    },

    listEntities(opts = {}) {
      const limit = Math.min(opts.limit ?? 50, 200)
      const conditions = []
      if (opts.cursor) {
        // Compound cursor: "timestamp|entity_key"
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
      const rows = db
        .select()
        .from(schema.entities)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(schema.entities.updated_at), desc(schema.entities.entity_key))
        .limit(limit + 1)
        .all() as EntityRow[]

      const hasMore = rows.length > limit
      if (hasMore) rows.pop()
      return {
        entities: rows,
        next_cursor:
          hasMore && rows.length > 0 ? `${rows[rows.length - 1].updated_at}|${rows[rows.length - 1].entity_key}` : null,
      }
    },

    getEntity(entityKey) {
      return (
        (db.select().from(schema.entities).where(eq(schema.entities.entity_key, entityKey)).get() as EntityRow) ?? null
      )
    },

    getEntityDispatches(entityKey) {
      return db
        .select()
        .from(schema.dispatches)
        .where(eq(schema.dispatches.entity_key, entityKey))
        .orderBy(desc(schema.dispatches.created_at))
        .all() as DispatchRow[]
    },

    getEntityLinks(entityKey) {
      const asSource = db.select().from(schema.links).where(eq(schema.links.source_key, entityKey)).all() as LinkRow[]
      const asTarget = db.select().from(schema.links).where(eq(schema.links.target_key, entityKey)).all() as LinkRow[]
      return [...asSource, ...asTarget]
    },

    listDispatches(opts = {}) {
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
      const rows = db
        .select()
        .from(schema.dispatches)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(schema.dispatches.created_at), desc(schema.dispatches.id))
        .limit(limit + 1)
        .all() as DispatchRow[]

      const hasMore = rows.length > limit
      if (hasMore) rows.pop()
      return {
        dispatches: rows,
        next_cursor:
          hasMore && rows.length > 0 ? `${rows[rows.length - 1].created_at}|${rows[rows.length - 1].id}` : null,
      }
    },

    getStats() {
      const totalEntities = db.select({ c: sql<number>`count(*)` }).from(schema.entities).get()?.c ?? 0
      const totalDispatches = db.select({ c: sql<number>`count(*)` }).from(schema.dispatches).get()?.c ?? 0
      const recent24h =
        db
          .select({ c: sql<number>`count(*)` })
          .from(schema.dispatches)
          .where(gt(schema.dispatches.created_at, sql`datetime('now', '-1 day')`))
          .get()?.c ?? 0
      const statusRows = db
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

    createCronJob(job) {
      db.insert(schema.cronJobs)
        .values({
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
        .run()
    },

    updateCronJob(id, updates) {
      const fields: Record<string, unknown> = { updated_at: now() }
      if (updates.name !== undefined) fields.name = updates.name
      if (updates.cron_expression !== undefined) fields.cron_expression = updates.cron_expression
      if (updates.prompt !== undefined) fields.prompt = updates.prompt
      if (updates.entity_key !== undefined) fields.entity_key = updates.entity_key
      if (updates.agent !== undefined) fields.agent = updates.agent
      if (updates.timezone !== undefined) fields.timezone = updates.timezone
      if (updates.enabled !== undefined) fields.enabled = updates.enabled ? 1 : 0
      if (updates.next_run_at !== undefined) fields.next_run_at = updates.next_run_at ?? null

      if (Object.keys(fields).length <= 1) return // only updated_at

      db.update(schema.cronJobs).set(fields).where(eq(schema.cronJobs.id, id)).run()
    },

    deleteCronJob(id) {
      db.delete(schema.cronJobs).where(eq(schema.cronJobs.id, id)).run()
    },

    getCronJob(id) {
      return (db.select().from(schema.cronJobs).where(eq(schema.cronJobs.id, id)).get() as CronJobRow) ?? null
    },

    getCronJobByName(name) {
      return (db.select().from(schema.cronJobs).where(eq(schema.cronJobs.name, name)).get() as CronJobRow) ?? null
    },

    listCronJobs(opts = {}) {
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
      const rows = db
        .select()
        .from(schema.cronJobs)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(schema.cronJobs.created_at), desc(schema.cronJobs.id))
        .limit(limit + 1)
        .all() as CronJobRow[]

      const hasMore = rows.length > limit
      if (hasMore) rows.pop()
      return {
        jobs: rows,
        next_cursor:
          hasMore && rows.length > 0 ? `${rows[rows.length - 1].created_at}|${rows[rows.length - 1].id}` : null,
      }
    },

    listEnabledCronJobs() {
      return db.select().from(schema.cronJobs).where(eq(schema.cronJobs.enabled, 1)).all() as CronJobRow[]
    },

    updateCronJobLastRun(id, lastRunAt, nextRunAt) {
      db.update(schema.cronJobs)
        .set({ last_run_at: lastRunAt, next_run_at: nextRunAt, updated_at: now() })
        .where(eq(schema.cronJobs.id, id))
        .run()
    },

    disableCronJob(id) {
      db.update(schema.cronJobs).set({ enabled: 0, updated_at: now() }).where(eq(schema.cronJobs.id, id)).run()
    },

    insertCronExecution(row) {
      db.insert(schema.cronExecutions)
        .values({
          id: row.id,
          cron_job_id: row.cron_job_id,
          scheduled_at: row.scheduled_at,
          status: row.status,
        })
        .run()
    },

    updateCronExecution(id, updates) {
      const fields: Record<string, unknown> = {}
      if (updates.dispatch_id !== undefined) fields.dispatch_id = updates.dispatch_id ?? null
      if (updates.status !== undefined) fields.status = updates.status
      if (updates.started_at !== undefined) fields.started_at = updates.started_at ?? null
      if (updates.completed_at !== undefined) fields.completed_at = updates.completed_at ?? null

      if (Object.keys(fields).length === 0) return

      db.update(schema.cronExecutions).set(fields).where(eq(schema.cronExecutions.id, id)).run()
    },

    listCronExecutions(jobId, opts = {}) {
      const limit = Math.min(opts.limit ?? 50, 200)
      return db
        .select()
        .from(schema.cronExecutions)
        .where(eq(schema.cronExecutions.cron_job_id, jobId))
        .orderBy(desc(schema.cronExecutions.scheduled_at))
        .limit(limit)
        .all() as CronExecutionRow[]
    },

    pruneOlderThan(days: number) {
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().replace("T", " ").slice(0, 19)
      // Use raw SQL in a transaction for pruning — these are bulk operations
      // that benefit from direct SQL over the query builder.
      const result = sqlite.transaction(() => {
        const dResult = sqlite
          .prepare("DELETE FROM dispatches WHERE created_at < ? AND status NOT IN ('started')")
          .run(cutoff)
        const ceResult = sqlite
          .prepare("DELETE FROM cron_executions WHERE scheduled_at < ? AND status NOT IN ('pending', 'running')")
          .run(cutoff)
        const eResult = sqlite
          .prepare(
            `DELETE FROM entities WHERE updated_at < ?
             AND entity_key NOT IN (SELECT DISTINCT entity_key FROM dispatches WHERE entity_key IS NOT NULL)`,
          )
          .run(cutoff)
        const lResult = sqlite
          .prepare(
            `DELETE FROM links WHERE source_key NOT IN (SELECT entity_key FROM entities)
             AND target_key NOT IN (SELECT entity_key FROM entities)`,
          )
          .run()
        return {
          dispatches: dResult.changes,
          entities: eResult.changes,
          cron_executions: ceResult.changes,
          links: lResult.changes,
        }
      })()
      return result
    },

    getRetentionDays() {
      const row = db.select().from(schema.metadata).where(eq(schema.metadata.key, "retention_days")).get()
      if (!row) return null
      const n = Number(row.value)
      return Number.isFinite(n) && n > 0 ? n : null
    },

    setRetentionDays(days: number) {
      sqlite
        .prepare(
          "INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run("retention_days", String(days))
    },

    close() {
      sqlite.close()
    },
  }
}
