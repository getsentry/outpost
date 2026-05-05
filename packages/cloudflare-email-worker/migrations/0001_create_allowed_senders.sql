CREATE TABLE IF NOT EXISTS allowed_senders (
  pattern    TEXT NOT NULL PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('exact', 'regex')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
