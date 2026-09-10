import { describe, expect, it, vi } from "vitest"
import { ScheduleRunner } from "../runner"
import { nextRunnerWakeAt } from "../runner-state"

describe("nextRunnerWakeAt", () => {
  it("keeps the scheduled due time while waking early to monitor active work", () => {
    expect(nextRunnerWakeAt({ scheduleDueAt: 360_000, hasActiveRun: true, now: 1_000 })).toBe(121_000)
  })

  it("does not monitor later than the scheduled occurrence", () => {
    expect(nextRunnerWakeAt({ scheduleDueAt: 4_000, hasActiveRun: true, now: 3_000 })).toBe(4_000)
  })
})

describe("ScheduleRunner arm", () => {
  it("keeps an alarm for active work even when its recurrence has no next due time", async () => {
    const storage = {
      put: vi.fn(),
      setAlarm: vi.fn(),
      deleteAlarm: vi.fn(),
    }
    const run = vi.fn().mockResolvedValue({ meta: { changes: 1 } })
    const durableObject = new ScheduleRunner(
      { storage } as never,
      { DB: { prepare: () => ({ bind: () => ({ run }) }) } } as never,
    )

    await durableObject.arm({ scheduleId: "schedule-1", revision: 2, nextDueAt: null, wakeAt: 123_456 })

    expect(storage.setAlarm).toHaveBeenCalledWith(123_456)
    expect(storage.deleteAlarm).not.toHaveBeenCalled()
  })
})
