import { createLogger } from "@jared/utils"
import { drizzle } from "drizzle-orm/d1"
import * as dbSchema from "@/db/schema"
import { dispatchGitHubEvent } from "@/lib/github/dispatch"
import type { BaseEnvBindings } from "@/types/env/base"

type Env = BaseEnvBindings["Bindings"]

/** Give Jared time to finish the current turn before presenting the inbox again. */
export const DISCUSSION_RETRY_DELAY_MS = 15 * 60 * 1000
/** Three reminders are enough to recover from a missed turn without self-looping forever. */
export const MAX_DISCUSSION_REMINDERS = 3

type RetryCandidate = {
  status: string
  reminderCount: number
  lastRemindedAt: Date | null
}

export function shouldRetryDiscussion(candidate: RetryCandidate, now = Date.now()): boolean {
  if (candidate.status !== "open" || candidate.reminderCount >= MAX_DISCUSSION_REMINDERS) return false
  return candidate.lastRemindedAt === null || candidate.lastRemindedAt.getTime() <= now - DISCUSSION_RETRY_DELAY_MS
}

type DiscussionRetryRow = {
  id: string
  repo: string
  pr_number: number
  entity_key: string
  reminder_count: number
  last_reminded_at: number | null
  status: string
  event_id: string
  event: string
  action: string | null
  delivery_id: string
  sender: string | null
  event_repo: string | null
  installation_id: number | null
  payload: string
}

export type DiscussionRetryResult = { retried: number; needsHuman: number }

/**
 * Wake Jared with one original event per PR after a missed discussion inbox.
 * Reusing one event renders every still-open obligation for that PR, avoiding
 * a burst of duplicate prompts when several reviewers wrote at once. After
 * three missed reminders, the entire outstanding PR batch becomes needs_human.
 */
export async function retryOpenDiscussionObligations(
  env: Env,
  scheduledTime: number,
  opts: { maxRows?: number } = {},
): Promise<DiscussionRetryResult> {
  // A retry can cold-start a sandbox. Keep one cron invocation bounded so it
  // cannot monopolize the Worker when several old discussions need attention.
  const maxRows = opts.maxRows ?? 10
  const rows = await env.DB.prepare(
    `SELECT o.id, o.repo, o.pr_number, o.entity_key, o.reminder_count, o.last_reminded_at, o.status, o.event_id,
            e.event, e.action, e.delivery_id, e.sender, e.repo AS event_repo, e.installation_id, e.payload
       FROM github_discussion_obligations o
       JOIN webhook_events e ON e.id = o.event_id
      WHERE o.status = 'open'
        AND NOT EXISTS (
          SELECT 1
            FROM github_discussion_obligations earlier
           WHERE earlier.status = 'open'
             AND earlier.repo = o.repo
             AND earlier.pr_number = o.pr_number
             AND (earlier.created_at < o.created_at OR (earlier.created_at = o.created_at AND earlier.id < o.id))
        )
      ORDER BY o.created_at ASC
      LIMIT ?`,
  )
    .bind(maxRows)
    .all<DiscussionRetryRow>()

  const db = drizzle(env.DB, { schema: dbSchema })
  const logger = createLogger({ level: env.ENV === "development" ? "debug" : "info", namespace: "discussion.retry" })
  let retried = 0
  let needsHuman = 0

  for (const row of rows.results ?? []) {
    const candidate: RetryCandidate = {
      status: row.status,
      reminderCount: row.reminder_count,
      lastRemindedAt: row.last_reminded_at === null ? null : new Date(row.last_reminded_at * 1000),
    }
    if (candidate.reminderCount >= MAX_DISCUSSION_REMINDERS) {
      await env.DB.prepare(
        "UPDATE github_discussion_obligations SET status = 'needs_human', updated_at = ? WHERE repo = ? AND pr_number = ? AND status = 'open'",
      )
        .bind(Math.floor(scheduledTime / 1000), row.repo, row.pr_number)
        .run()
      needsHuman += 1
      continue
    }
    if (!shouldRetryDiscussion(candidate, scheduledTime)) continue

    const retriedRow = await env.DB.prepare(
      "UPDATE github_discussion_obligations SET reminder_count = reminder_count + 1, last_reminded_at = ?, updated_at = ? WHERE repo = ? AND pr_number = ? AND status = 'open' AND reminder_count < ? AND (last_reminded_at IS NULL OR last_reminded_at <= ?)",
    )
      .bind(
        Math.floor(scheduledTime / 1000),
        Math.floor(scheduledTime / 1000),
        row.repo,
        row.pr_number,
        MAX_DISCUSSION_REMINDERS,
        Math.floor((scheduledTime - DISCUSSION_RETRY_DELAY_MS) / 1000),
      )
      .run()
    // Another overlapping cron may have reclaimed this row while we were
    // reading it. Only the execution that won the guarded update dispatches.
    if ((retriedRow.meta.changes ?? 0) === 0) continue
    retried += 1
    await dispatchGitHubEvent(env, db, logger, {
      eventId: row.event_id,
      containerKey: row.entity_key,
      event: row.event,
      action: row.action,
      deliveryId: row.delivery_id,
      sender: row.sender,
      repo: row.event_repo,
      installationId: row.installation_id,
      payload: row.payload,
    })
  }

  return { retried, needsHuman }
}
