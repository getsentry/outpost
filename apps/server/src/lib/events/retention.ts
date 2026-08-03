/** Webhook event retention period: exactly 24 hours. */
export const WEBHOOK_EVENT_RETENTION_MS = 24 * 60 * 60 * 1000

/** Return the D1 integer-timestamp cutoff for a retention run. */
export function webhookEventCutoffSeconds(now = Date.now()): number {
  return Math.floor((now - WEBHOOK_EVENT_RETENTION_MS) / 1000)
}

/**
 * Delete webhook events strictly older than the retention cutoff.
 *
 * D1 stores Drizzle `timestamp` integers as Unix seconds, so bind the cutoff
 * in seconds rather than milliseconds.
 */
export async function deleteExpiredWebhookEvents(db: D1Database, now = Date.now()): Promise<number> {
  const result = await db
    .prepare("DELETE FROM webhook_events WHERE created_at < ?")
    .bind(webhookEventCutoffSeconds(now))
    .run()

  return result.meta.changes
}
