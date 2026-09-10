import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull(),
  image: text("image"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  metadata: text({ mode: "json" }).$type<Record<string, unknown>>(),
})

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
})

export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: integer("access_token_expires_at", {
    mode: "timestamp",
  }),
  refreshTokenExpiresAt: integer("refresh_token_expires_at", {
    mode: "timestamp",
  }),
  scope: text("scope"),
  password: text("password"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
})

export const verifications = sqliteTable("verifications", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
})

export const webhookEvents = sqliteTable(
  "webhook_events",
  {
    id: text("id").primaryKey(),
    entityKey: text("entity_key").notNull(),
    event: text("event").notNull(),
    action: text("action"),
    deliveryId: text("delivery_id").notNull().unique(),
    sender: text("sender"),
    repo: text("repo"),
    installationId: integer("installation_id"),
    payload: text("payload").notNull(),
    status: text("status").notNull().default("pending"),
    // Immutable correlation anchor for the asynchronous Worker -> Flue handoff.
    // Lifecycle status deliberately changes after admission; this value does not.
    flueSubmissionId: text("flue_submission_id"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    dispatchedAt: integer("dispatched_at", { mode: "timestamp" }),
    completedAt: integer("completed_at", { mode: "timestamp" }),
  },
  (table) => [
    index("idx_webhook_events_entity_status").on(table.entityKey, table.status),
    uniqueIndex("idx_webhook_events_flue_submission_id").on(table.flueSubmissionId),
  ],
)

export const githubDiscussionObligations = sqliteTable(
  "github_discussion_obligations",
  {
    id: text("id").primaryKey(),
    repo: text("repo").notNull(),
    prNumber: integer("pr_number").notNull(),
    entityKey: text("entity_key").notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceCommentId: text("source_comment_id").notNull(),
    replyToCommentId: text("reply_to_comment_id"),
    author: text("author").notNull(),
    body: text("body").notNull(),
    url: text("url"),
    eventId: text("event_id").notNull(),
    installationId: integer("installation_id"),
    status: text("status").notNull().default("open"),
    outcome: text("outcome"),
    verifiedAt: integer("verified_at", { mode: "timestamp" }),
    reminderCount: integer("reminder_count").notNull().default(0),
    lastRemindedAt: integer("last_reminded_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    uniqueIndex("github_discussion_obligations_repo_source_unique").on(
      table.repo,
      table.sourceKind,
      table.sourceCommentId,
    ),
    index("idx_github_discussion_obligations_repo_pr_status_created").on(
      table.repo,
      table.prNumber,
      table.status,
      table.createdAt,
    ),
    index("idx_github_discussion_obligations_status_created").on(table.status, table.createdAt),
    index("idx_github_discussion_obligations_entity_status").on(table.entityKey, table.status),
  ],
)

/**
 * Compact durable state for a human request that must survive sandbox reuse and
 * Flue conversation compaction. This deliberately stores goals and external
 * evidence, never a second copy of model transcripts or webhook payloads.
 */
export const agentWorkItems = sqliteTable(
  "agent_work_items",
  {
    id: text("id").primaryKey(),
    workKey: text("work_key").notNull(),
    entityKey: text("entity_key").notNull(),
    repo: text("repo").notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceId: text("source_id").notNull(),
    goal: text("goal").notNull(),
    targetPrNumber: integer("target_pr_number"),
    stage: text("stage").notNull().default("queued"),
    artifactUrl: text("artifact_url"),
    artifactSha: text("artifact_sha"),
    blocker: text("blocker"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
    completedAt: integer("completed_at", { mode: "timestamp" }),
  },
  (table) => [
    uniqueIndex("agent_work_items_repo_source_unique").on(table.repo, table.sourceKind, table.sourceId),
    index("idx_agent_work_items_work_stage_updated").on(table.workKey, table.stage, table.updatedAt),
    index("idx_agent_work_items_entity_stage_updated").on(table.entityKey, table.stage, table.updatedAt),
  ],
)

export const agentSessions = sqliteTable("agent_sessions", {
  entityKey: text("entity_key").primaryKey(),
  sessionId: text("session_id"),
  sessionData: text("session_data").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
})

/** Durable-run fence for delayed follow-ups after an operator destroys a run. */
export const agentLifecycle = sqliteTable("agent_lifecycle", {
  instanceId: text("instance_id").primaryKey(),
  generation: integer("generation").notNull().default(1),
  destroyedAt: integer("destroyed_at", { mode: "timestamp" }),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
})

/** Recent cron executions, used to detect a disabled or failing scheduler. */
export const maintenanceRuns = sqliteTable("maintenance_runs", {
  id: text("id").primaryKey(),
  cron: text("cron").notNull(),
  scheduledAt: integer("scheduled_at", { mode: "timestamp" }).notNull(),
  completedAt: integer("completed_at", { mode: "timestamp" }).notNull(),
  outcome: text("outcome").notNull(),
})

/** Operator-configured prompt recurrence. D1 is authoritative; the per-job DO only arms alarms. */
export const scheduledJobs = sqliteTable(
  "scheduled_jobs",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    repo: text("repo").notNull(),
    prompt: text("prompt").notNull(),
    cadence: text("cadence").notNull(),
    localTime: text("local_time").notNull(),
    timezone: text("timezone").notNull(),
    dayOfWeek: integer("day_of_week"),
    dayOfMonth: integer("day_of_month"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    revision: integer("revision").notNull().default(1),
    armedRevision: integer("armed_revision"),
    nextDueAt: integer("next_due_at", { mode: "timestamp_ms" }),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("idx_scheduled_jobs_enabled_due").on(table.enabled, table.nextDueAt),
    index("idx_scheduled_jobs_archived_updated").on(table.archivedAt, table.updatedAt),
  ],
)

/** Immutable execution evidence for one scheduled or operator-confirmed occurrence. */
export const scheduledJobRuns = sqliteTable(
  "scheduled_job_runs",
  {
    id: text("id").primaryKey(),
    scheduleId: text("schedule_id").notNull(),
    scheduleRevision: integer("schedule_revision").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    trigger: text("trigger").notNull(),
    intendedAt: integer("intended_at", { mode: "timestamp_ms" }).notNull(),
    repo: text("repo").notNull(),
    prompt: text("prompt").notNull(),
    entityKey: text("entity_key"),
    flueSubmissionId: text("flue_submission_id"),
    status: text("status").notNull(),
    attempts: integer("attempts").notNull().default(0),
    failureReason: text("failure_reason"),
    artifactUrl: text("artifact_url"),
    artifactKind: text("artifact_kind"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    admittedAt: integer("admitted_at", { mode: "timestamp_ms" }),
    settledAt: integer("settled_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("scheduled_job_runs_schedule_dedupe_unique").on(table.scheduleId, table.dedupeKey),
    index("idx_scheduled_job_runs_schedule_created").on(table.scheduleId, table.createdAt),
    index("idx_scheduled_job_runs_status_updated").on(table.status, table.updatedAt),
    uniqueIndex("scheduled_job_runs_entity_unique").on(table.entityKey),
  ],
)

/** Small fixed pool reserving sandbox capacity for scheduled work without consuming all ten instances. */
export const scheduledRunSlots = sqliteTable("scheduled_run_slots", {
  slot: integer("slot").primaryKey(),
  runId: text("run_id"),
  leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
})
