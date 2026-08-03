import { describe, expect, it, vi } from "vitest"
import {
  deleteExpiredWebhookEvents,
  WEBHOOK_EVENT_RETENTION_MS,
  webhookEventCutoffSeconds,
} from "../retention"

describe("webhook event retention", () => {
  it("computes a Unix-second cutoff exactly 24 hours before the run", () => {
    const now = Date.UTC(2026, 7, 3, 3, 17, 0)

    expect(webhookEventCutoffSeconds(now)).toBe(
      Math.floor((now - WEBHOOK_EVENT_RETENTION_MS) / 1000),
    )
  })

  it("deletes only rows older than the cutoff", async () => {
    const run = vi.fn().mockResolvedValue({ meta: { changes: 7 } })
    const bind = vi.fn().mockReturnValue({ run })
    const prepare = vi.fn().mockReturnValue({ bind })
    const now = Date.UTC(2026, 7, 3, 3, 17, 0)

    const deleted = await deleteExpiredWebhookEvents(
      { prepare } as unknown as D1Database,
      now,
    )

    expect(prepare).toHaveBeenCalledWith("DELETE FROM webhook_events WHERE created_at < ?")
    expect(bind).toHaveBeenCalledWith(webhookEventCutoffSeconds(now))
    expect(run).toHaveBeenCalledOnce()
    expect(deleted).toBe(7)
  })
})
