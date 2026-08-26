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
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    dispatchedAt: integer("dispatched_at", { mode: "timestamp" }),
    completedAt: integer("completed_at", { mode: "timestamp" }),
  },
  (table) => [index("idx_webhook_events_entity_status").on(table.entityKey, table.status)],
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
    index("idx_github_discussion_obligations_entity_status").on(table.entityKey, table.status),
  ],
)

export const agentSessions = sqliteTable("agent_sessions", {
  entityKey: text("entity_key").primaryKey(),
  sessionId: text("session_id"),
  sessionData: text("session_data").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
})
