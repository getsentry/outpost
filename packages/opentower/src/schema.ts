// Drizzle ORM schema for the opentower lifecycle store.

import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const entities = sqliteTable(
  "entities",
  {
    entity_key: text("entity_key").primaryKey(),
    repo: text("repo").notNull(),
    number: integer("number").notNull(),
    kind: text("kind", { enum: ["issue", "pull_request"] }).notNull(),
    session_id: text("session_id").notNull(),
    share_url: text("share_url"),
    cwd: text("cwd"),
    agent: text("agent").notNull(),
    created_at: text("created_at")
      .notNull()
      .$defaultFn(() => sqliteDatetimeNow()),
    updated_at: text("updated_at")
      .notNull()
      .$defaultFn(() => sqliteDatetimeNow()),
  },
  (table) => [index("idx_entities_updated_key").on(table.updated_at, table.entity_key)],
)

export const links = sqliteTable(
  "links",
  {
    source_key: text("source_key").notNull(),
    target_key: text("target_key").notNull(),
    relation: text("relation").notNull(),
    created_at: text("created_at")
      .notNull()
      .$defaultFn(() => sqliteDatetimeNow()),
  },
  (table) => [
    primaryKey({ columns: [table.source_key, table.target_key] }),
    index("idx_links_target").on(table.target_key),
  ],
)

export const dispatches = sqliteTable(
  "dispatches",
  {
    id: text("id").primaryKey(),
    entity_key: text("entity_key"),
    session_id: text("session_id"),
    share_url: text("share_url"),
    cwd: text("cwd"),
    trigger_name: text("trigger_name").notNull(),
    event: text("event").notNull(),
    delivery_id: text("delivery_id").notNull(),
    status: text("status")
      .notNull()
      .$default(() => "started"),
    created_at: text("created_at")
      .notNull()
      .$defaultFn(() => sqliteDatetimeNow()),
    completed_at: text("completed_at"),
  },
  (table) => [
    index("idx_dispatches_entity").on(table.entity_key),
    index("idx_dispatches_delivery").on(table.delivery_id),
    index("idx_dispatches_created_id").on(table.created_at, table.id),
  ],
)

export const cronJobs = sqliteTable(
  "cron_jobs",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull().unique(),
    cron_expression: text("cron_expression").notNull(),
    prompt: text("prompt").notNull(),
    entity_key: text("entity_key"),
    agent: text("agent").notNull(),
    timezone: text("timezone")
      .notNull()
      .$default(() => "UTC"),
    enabled: integer("enabled")
      .notNull()
      .$default(() => 1),
    run_once: integer("run_once")
      .notNull()
      .$default(() => 0),
    created_by: text("created_by").notNull(),
    created_at: text("created_at")
      .notNull()
      .$defaultFn(() => sqliteDatetimeNow()),
    updated_at: text("updated_at")
      .notNull()
      .$defaultFn(() => sqliteDatetimeNow()),
    last_run_at: text("last_run_at"),
    next_run_at: text("next_run_at"),
  },
  (table) => [index("idx_cron_jobs_enabled").on(table.enabled), index("idx_cron_jobs_next_run").on(table.next_run_at)],
)

export const cronExecutions = sqliteTable(
  "cron_executions",
  {
    id: text("id").primaryKey(),
    cron_job_id: text("cron_job_id")
      .notNull()
      .references(() => cronJobs.id, { onDelete: "cascade" }),
    dispatch_id: text("dispatch_id"),
    status: text("status")
      .notNull()
      .$default(() => "pending"),
    scheduled_at: text("scheduled_at").notNull(),
    started_at: text("started_at"),
    completed_at: text("completed_at"),
  },
  (table) => [index("idx_cron_executions_job").on(table.cron_job_id)],
)

export const metadata = sqliteTable("metadata", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
})

function sqliteDatetimeNow(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19)
}
