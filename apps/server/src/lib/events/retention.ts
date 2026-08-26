/** Retention for actionable webhook events (pending/dispatched/failed/…). */
export const WEBHOOK_EVENT_RETENTION_MS = 24 * 60 * 60 * 1000

/** Retention for skipped events — shorter since they store only a reason stub. */
export const SKIPPED_WEBHOOK_EVENT_RETENTION_MS = 6 * 60 * 60 * 1000

/** Return the D1 integer-timestamp cutoff for a retention run. */
export function webhookEventCutoffSeconds(now = Date.now(), retentionMs = WEBHOOK_EVENT_RETENTION_MS): number {
  return Math.floor((now - retentionMs) / 1000)
}

/**
 * Delete webhook events past their retention window.
 *
 * Skipped events expire after 6h; everything else after 24h.
 * D1 stores Drizzle `timestamp` integers as Unix seconds.
 */
export async function deleteExpiredWebhookEvents(db: D1Database, now = Date.now()): Promise<number> {
  const actionableCutoff = webhookEventCutoffSeconds(now, WEBHOOK_EVENT_RETENTION_MS)
  const skippedCutoff = webhookEventCutoffSeconds(now, SKIPPED_WEBHOOK_EVENT_RETENTION_MS)

  const actionable = await db
    .prepare(
      "DELETE FROM webhook_events WHERE status != 'skipped' AND created_at < ? AND NOT EXISTS (SELECT 1 FROM github_discussion_obligations WHERE event_id = webhook_events.id AND status = 'open')",
    )
    .bind(actionableCutoff)
    .run()

  const skipped = await db
    .prepare("DELETE FROM webhook_events WHERE status = 'skipped' AND created_at < ?")
    .bind(skippedCutoff)
    .run()

  return (actionable.meta.changes ?? 0) + (skipped.meta.changes ?? 0)
}
