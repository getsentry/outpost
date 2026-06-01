-- Migration: initial schema for outpost lifecycle store (D1).
-- Port of the SQLite schema from opentower.

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
CREATE INDEX IF NOT EXISTS idx_entities_updated_key ON entities(updated_at, entity_key);

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
CREATE INDEX IF NOT EXISTS idx_dispatches_delivery ON dispatches(delivery_id);
CREATE INDEX IF NOT EXISTS idx_dispatches_created_id ON dispatches(created_at, id);

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

-- Dedup table for webhook delivery ID deduplication.
CREATE TABLE IF NOT EXISTS dedup_entries (
  delivery_id TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
