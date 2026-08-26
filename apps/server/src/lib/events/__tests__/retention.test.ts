import { describe, expect, it, vi } from "vitest"
import {
  deleteExpiredWebhookEvents,
  SKIPPED_WEBHOOK_EVENT_RETENTION_MS,
  WEBHOOK_EVENT_RETENTION_MS,
  webhookEventCutoffSeconds,
} from "../retention"

describe("webhook event retention", () => {
  it("computes a Unix-second cutoff for the given retention window", () => {
    const now = Date.UTC(2026, 7, 3, 3, 17, 0)

    expect(webhookEventCutoffSeconds(now)).toBe(Math.floor((now - WEBHOOK_EVENT_RETENTION_MS) / 1000))
    expect(webhookEventCutoffSeconds(now, SKIPPED_WEBHOOK_EVENT_RETENTION_MS)).toBe(
      Math.floor((now - SKIPPED_WEBHOOK_EVENT_RETENTION_MS) / 1000),
    )
  })

  it("deletes actionable and skipped rows with differential cutoffs", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ meta: { changes: 7 } })
      .mockResolvedValueOnce({ meta: { changes: 12 } })
    const bind = vi.fn().mockReturnValue({ run })
    const prepare = vi.fn().mockReturnValue({ bind })
    const now = Date.UTC(2026, 7, 3, 3, 17, 0)

    const deleted = await deleteExpiredWebhookEvents({ prepare } as unknown as D1Database, now)

    expect(prepare).toHaveBeenNthCalledWith(
      1,
      "DELETE FROM webhook_events WHERE status != 'skipped' AND created_at < ? AND NOT EXISTS (SELECT 1 FROM github_discussion_obligations WHERE event_id = webhook_events.id AND status = 'open')",
    )
    expect(bind).toHaveBeenNthCalledWith(1, webhookEventCutoffSeconds(now, WEBHOOK_EVENT_RETENTION_MS))
    expect(prepare).toHaveBeenNthCalledWith(2, "DELETE FROM webhook_events WHERE status = 'skipped' AND created_at < ?")
    expect(bind).toHaveBeenNthCalledWith(2, webhookEventCutoffSeconds(now, SKIPPED_WEBHOOK_EVENT_RETENTION_MS))
    expect(deleted).toBe(19)
  })
})
