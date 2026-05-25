// Database migration runner with schema verification and auto-repair.
//
// Each migration is a numbered SQL string that runs exactly once. The
// current version is tracked in a `schema_version` table so the runner
// knows where to resume after a restart or upgrade.
//
// After migrations, verifySchema() checks that every expected table,
// column, and index exists. If anything is missing (e.g., interrupted
// migration, manual tampering, binary swap without DB reset),
// repairSchema() creates the missing pieces.
//
// Inspired by getsentry/cli's schema.ts approach — single source of
// truth for schema definitions, auto-repair as a safety net.

import type { Database } from "bun:sqlite"
import { logger } from "./logger"

// ---------------------------------------------------------------------------
// Expected schema — single source of truth for verification and repair
// ---------------------------------------------------------------------------

type ExpectedColumn = {
  name: string
  type: string
  notNull?: boolean
}

type ExpectedTable = {
  name: string
  columns: ExpectedColumn[]
}

type ExpectedIndex = {
  name: string
  table: string
  columns: string[]
}

const EXPECTED_TABLES: ExpectedTable[] = [
  {
    name: "entities",
    columns: [
      { name: "entity_key", type: "TEXT", notNull: true },
      { name: "repo", type: "TEXT", notNull: true },
      { name: "number", type: "INTEGER", notNull: true },
      { name: "kind", type: "TEXT", notNull: true },
      { name: "session_id", type: "TEXT", notNull: true },
      { name: "share_url", type: "TEXT" },
      { name: "cwd", type: "TEXT" },
      { name: "agent", type: "TEXT", notNull: true },
      { name: "created_at", type: "TEXT", notNull: true },
      { name: "updated_at", type: "TEXT", notNull: true },
    ],
  },
  {
    name: "links",
    columns: [
      { name: "source_key", type: "TEXT", notNull: true },
      { name: "target_key", type: "TEXT", notNull: true },
      { name: "relation", type: "TEXT", notNull: true },
      { name: "created_at", type: "TEXT", notNull: true },
    ],
  },
  {
    name: "dispatches",
    columns: [
      { name: "id", type: "TEXT", notNull: true },
      { name: "entity_key", type: "TEXT" },
      { name: "session_id", type: "TEXT" },
      { name: "share_url", type: "TEXT" },
      { name: "cwd", type: "TEXT" },
      { name: "trigger_name", type: "TEXT", notNull: true },
      { name: "event", type: "TEXT", notNull: true },
      { name: "delivery_id", type: "TEXT", notNull: true },
      { name: "status", type: "TEXT", notNull: true },
      { name: "created_at", type: "TEXT", notNull: true },
      { name: "completed_at", type: "TEXT" },
    ],
  },
  {
    name: "cron_jobs",
    columns: [
      { name: "id", type: "TEXT", notNull: true },
      { name: "name", type: "TEXT", notNull: true },
      { name: "cron_expression", type: "TEXT", notNull: true },
      { name: "prompt", type: "TEXT", notNull: true },
      { name: "entity_key", type: "TEXT" },
      { name: "agent", type: "TEXT", notNull: true },
      { name: "timezone", type: "TEXT", notNull: true },
      { name: "enabled", type: "INTEGER", notNull: true },
      { name: "run_once", type: "INTEGER", notNull: true },
      { name: "created_by", type: "TEXT", notNull: true },
      { name: "created_at", type: "TEXT", notNull: true },
      { name: "updated_at", type: "TEXT", notNull: true },
      { name: "last_run_at", type: "TEXT" },
      { name: "next_run_at", type: "TEXT" },
    ],
  },
  {
    name: "cron_executions",
    columns: [
      { name: "id", type: "TEXT", notNull: true },
      { name: "cron_job_id", type: "TEXT", notNull: true },
      { name: "dispatch_id", type: "TEXT" },
      { name: "status", type: "TEXT", notNull: true },
      { name: "scheduled_at", type: "TEXT", notNull: true },
      { name: "started_at", type: "TEXT" },
      { name: "completed_at", type: "TEXT" },
    ],
  },
  {
    name: "metadata",
    columns: [
      { name: "key", type: "TEXT", notNull: true },
      { name: "value", type: "TEXT", notNull: true },
    ],
  },
]

const EXPECTED_INDEXES: ExpectedIndex[] = [
  { name: "idx_links_target", table: "links", columns: ["target_key"] },
  { name: "idx_dispatches_entity", table: "dispatches", columns: ["entity_key"] },
  { name: "idx_dispatches_delivery", table: "dispatches", columns: ["delivery_id"] },
  { name: "idx_dispatches_created_id", table: "dispatches", columns: ["created_at", "id"] },
  { name: "idx_entities_updated_key", table: "entities", columns: ["updated_at", "entity_key"] },
  { name: "idx_cron_jobs_enabled", table: "cron_jobs", columns: ["enabled"] },
  { name: "idx_cron_jobs_next_run", table: "cron_jobs", columns: ["next_run_at"] },
  { name: "idx_cron_executions_job", table: "cron_executions", columns: ["cron_job_id"] },
]

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

type Migration = {
  version: number
  description: string
  sql: string
}

// Each migration's SQL is executed inside a transaction together with
// the version bump. Add new migrations to the END of this array.
const migrations: Migration[] = [
  {
    version: 1,
    description: "baseline schema — tables, indexes, metadata",
    sql: `
CREATE TABLE IF NOT EXISTS entities (
  entity_key TEXT PRIMARY KEY,
  repo       TEXT NOT NULL,
  number     INTEGER NOT NULL,
  kind       TEXT NOT NULL CHECK(kind IN ('issue', 'pull_request')),
  session_id TEXT NOT NULL,
  share_url  TEXT,
  cwd        TEXT,
  agent      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS links (
  source_key TEXT NOT NULL,
  target_key TEXT NOT NULL,
  relation   TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (source_key, target_key)
);
CREATE INDEX IF NOT EXISTS idx_links_target ON links(target_key);

CREATE TABLE IF NOT EXISTS dispatches (
  id           TEXT PRIMARY KEY,
  entity_key   TEXT,
  session_id   TEXT,
  share_url    TEXT,
  cwd          TEXT,
  trigger_name TEXT NOT NULL,
  event        TEXT NOT NULL,
  delivery_id  TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'started',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_dispatches_entity ON dispatches(entity_key);

CREATE TABLE IF NOT EXISTS cron_jobs (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  cron_expression TEXT NOT NULL,
  prompt          TEXT NOT NULL,
  entity_key      TEXT,
  agent           TEXT NOT NULL,
  timezone        TEXT NOT NULL DEFAULT 'UTC',
  enabled         INTEGER NOT NULL DEFAULT 1,
  run_once        INTEGER NOT NULL DEFAULT 0,
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_run_at     TEXT,
  next_run_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_cron_jobs_enabled ON cron_jobs(enabled);
CREATE INDEX IF NOT EXISTS idx_cron_jobs_next_run ON cron_jobs(next_run_at);

CREATE TABLE IF NOT EXISTS cron_executions (
  id           TEXT PRIMARY KEY,
  cron_job_id  TEXT NOT NULL,
  dispatch_id  TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',
  scheduled_at TEXT NOT NULL,
  started_at   TEXT,
  completed_at TEXT,
  FOREIGN KEY (cron_job_id) REFERENCES cron_jobs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_cron_executions_job ON cron_executions(cron_job_id);

CREATE TABLE IF NOT EXISTS metadata (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`,
  },
  {
    version: 2,
    description: "add compound indexes for cursor pagination and delivery_id index",
    sql: `
CREATE INDEX IF NOT EXISTS idx_dispatches_delivery ON dispatches(delivery_id);
CREATE INDEX IF NOT EXISTS idx_dispatches_created_id ON dispatches(created_at, id);
CREATE INDEX IF NOT EXISTS idx_entities_updated_key ON entities(updated_at, entity_key);
`,
  },
]

// ---------------------------------------------------------------------------
// Schema verification
// ---------------------------------------------------------------------------

export type SchemaIssue =
  | { type: "missing_table"; table: string }
  | { type: "missing_column"; table: string; column: string }
  | { type: "missing_index"; index: string; table: string }

function tableExists(db: Database, table: string): boolean {
  const row = db.prepare("SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name=?").get(table) as {
    c: number
  }
  return row.c > 0
}

function hasColumn(db: Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>
  return rows.some((r) => r.name === column)
}

function indexExists(db: Database, indexName: string): boolean {
  const row = db.prepare("SELECT COUNT(*) as c FROM sqlite_master WHERE type='index' AND name=?").get(indexName) as {
    c: number
  }
  return row.c > 0
}

// Check the database schema against expectations and return any issues.
export function verifySchema(db: Database): SchemaIssue[] {
  const issues: SchemaIssue[] = []

  for (const table of EXPECTED_TABLES) {
    if (!tableExists(db, table.name)) {
      issues.push({ type: "missing_table", table: table.name })
      continue
    }
    for (const col of table.columns) {
      if (!hasColumn(db, table.name, col.name)) {
        issues.push({ type: "missing_column", table: table.name, column: col.name })
      }
    }
  }

  for (const idx of EXPECTED_INDEXES) {
    if (!indexExists(db, idx.name)) {
      issues.push({ type: "missing_index", index: idx.name, table: idx.table })
    }
  }

  return issues
}

// ---------------------------------------------------------------------------
// Auto-repair
// ---------------------------------------------------------------------------

export type RepairResult = {
  fixed: string[]
  failed: string[]
}

// Attempt to repair all schema issues. Creates missing tables, adds
// missing columns, and creates missing indexes.
export function repairSchema(db: Database): RepairResult {
  const result: RepairResult = { fixed: [], failed: [] }
  const issues = verifySchema(db)

  if (issues.length === 0) return result

  for (const issue of issues) {
    try {
      switch (issue.type) {
        case "missing_table": {
          // Find the migration that creates this table and re-run its
          // CREATE TABLE IF NOT EXISTS. We use the baseline migration (v1)
          // which has all tables.
          const baseline = migrations[0]
          if (baseline) {
            db.exec(baseline.sql)
            result.fixed.push(`created table ${issue.table}`)
          }
          break
        }
        case "missing_column": {
          const table = EXPECTED_TABLES.find((t) => t.name === issue.table)
          const col = table?.columns.find((c) => c.name === issue.column)
          const colType = col?.type ?? "TEXT"
          db.exec(`ALTER TABLE ${issue.table} ADD COLUMN ${issue.column} ${colType}`)
          result.fixed.push(`added column ${issue.table}.${issue.column} (${colType})`)
          break
        }
        case "missing_index": {
          const idx = EXPECTED_INDEXES.find((i) => i.name === issue.index)
          if (idx) {
            db.exec(`CREATE INDEX IF NOT EXISTS ${idx.name} ON ${idx.table}(${idx.columns.join(", ")})`)
            result.fixed.push(`created index ${issue.index}`)
          }
          break
        }
      }
    } catch (err) {
      result.failed.push(`${issue.type} ${issue.type === "missing_index" ? issue.index : issue.table}: ${err}`)
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

export type MigrationResult = {
  currentVersion: number
  appliedCount: number
  applied: string[]
}

// Run all pending migrations, then verify and repair the schema.
// Safe to call on every startup — already-applied migrations are skipped.
export function runMigrations(db: Database): MigrationResult {
  // Ensure the version-tracking table exists.
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version     INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  const currentVersion =
    (db.prepare("SELECT MAX(version) as v FROM schema_version").get() as { v: number | null })?.v ?? 0

  const pending = migrations.filter((m) => m.version > currentVersion)
  const applied: string[] = []

  // Apply pending migrations
  for (const m of pending) {
    db.transaction(() => {
      db.exec(m.sql)
      db.prepare("INSERT INTO schema_version (version, description) VALUES (?, ?)").run(m.version, m.description)
    })()

    applied.push(`v${m.version}: ${m.description}`)
    logger.info("migration applied", { version: m.version, description: m.description })
  }

  if (applied.length > 0) {
    const newVersion = pending[pending.length - 1].version
    logger.info("migrations complete", {
      previous_version: currentVersion,
      current_version: newVersion,
      applied_count: applied.length,
    })
  }

  // Verify schema integrity and auto-repair if needed.
  // This catches edge cases where the DB is inconsistent despite
  // migrations (interrupted migration, manual tampering, etc.).
  const issues = verifySchema(db)
  if (issues.length > 0) {
    logger.warn("schema issues detected after migrations", {
      issues: issues.map((i) => {
        if (i.type === "missing_index") return `${i.type}: ${i.index}`
        if (i.type === "missing_column") return `${i.type}: ${i.table}.${i.column}`
        return `${i.type}: ${i.table}`
      }),
    })

    const repair = repairSchema(db)
    if (repair.fixed.length > 0) {
      logger.info("schema auto-repaired", { fixed: repair.fixed })
    }
    if (repair.failed.length > 0) {
      logger.error("schema repair failures", { failed: repair.failed })
    }
  } else if (applied.length === 0) {
    logger.info("database up to date", { version: currentVersion })
  }

  const finalVersion =
    (db.prepare("SELECT MAX(version) as v FROM schema_version").get() as { v: number | null })?.v ?? currentVersion

  return { currentVersion: finalVersion, appliedCount: applied.length, applied }
}

// Return the current schema version without running anything.
export function getSchemaVersion(db: Database): number {
  try {
    return (db.prepare("SELECT MAX(version) as v FROM schema_version").get() as { v: number | null })?.v ?? 0
  } catch {
    return 0
  }
}
