import { describe, expect, it, vi } from "vitest"
import { recordMaintenanceRun } from "../maintenance"

describe("recordMaintenanceRun", () => {
  it("persists a timestamped cron heartbeat with outcome counters", async () => {
    const run = vi.fn().mockResolvedValue({ success: true })
    const bind = vi.fn().mockReturnValue({ run })
    const prepare = vi.fn().mockReturnValue({ bind })
    const scheduledAt = Date.UTC(2026, 8, 7, 6, 0, 0)

    await recordMaintenanceRun({ prepare } as unknown as D1Database, {
      cron: "*/15 * * * *",
      scheduledAt,
      deleted: 9,
      timedOut: 2,
      settled: 3,
      discussionRetries: 1,
    })

    expect(prepare).toHaveBeenCalledWith(
      "INSERT INTO maintenance_runs (id, cron, scheduled_at, completed_at, outcome) VALUES (?, ?, ?, ?, ?)",
    )
    expect(bind).toHaveBeenCalledWith(
      expect.any(String),
      "*/15 * * * *",
      Math.floor(scheduledAt / 1000),
      expect.any(Number),
      JSON.stringify({ deleted: 9, timedOut: 2, settled: 3, discussionRetries: 1 }),
    )
  })
})
