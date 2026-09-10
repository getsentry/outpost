import { describe, expect, it, vi } from "vitest"
import { settleScheduleRuns } from "../service"

function fakeDatabase(rows: Array<Record<string, unknown>>) {
  const calls: Array<{ sql: string; values: unknown[] }> = []
  const prepare = vi.fn((sql: string) => ({
    bind: (...values: unknown[]) => {
      calls.push({ sql, values })
      return {
        all: async () => ({ results: rows }),
        run: async () => ({ meta: { changes: 1 } }),
      }
    },
  }))
  return { database: { prepare }, calls }
}

describe("settleScheduleRuns", () => {
  it("releases a run stranded in preparation instead of blocking later occurrences", async () => {
    const now = Date.UTC(2026, 8, 9, 0, 0, 0)
    const clock = vi.spyOn(Date, "now").mockReturnValue(now)
    const { database, calls } = fakeDatabase([
      {
        id: "run-1",
        entity_key: null,
        status: "preparing",
        created_at: now - 3 * 60 * 60 * 1000,
        updated_at: now - 3 * 60 * 60 * 1000,
      },
    ])

    await settleScheduleRuns({ DB: database } as never, "schedule-1")

    expect(calls.map((call) => call.sql)).toContain(
      "UPDATE scheduled_job_runs SET status = 'failed', failure_reason = COALESCE(failure_reason, 'Scheduled run did not finish preparation'), updated_at = ? WHERE id = ? AND status = 'preparing'",
    )
    expect(calls.map((call) => call.sql)).toContain(
      "UPDATE scheduled_run_slots SET run_id = NULL, lease_expires_at = NULL WHERE run_id = ?",
    )
    clock.mockRestore()
  })
})
