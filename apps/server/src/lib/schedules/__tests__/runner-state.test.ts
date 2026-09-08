import { describe, expect, it } from "vitest"
import { nextRunnerWakeAt } from "../runner-state"

describe("nextRunnerWakeAt", () => {
  it("keeps the scheduled due time while waking early to monitor active work", () => {
    expect(nextRunnerWakeAt({ scheduleDueAt: 360_000, hasActiveRun: true, now: 1_000 })).toBe(121_000)
  })

  it("does not monitor later than the scheduled occurrence", () => {
    expect(nextRunnerWakeAt({ scheduleDueAt: 4_000, hasActiveRun: true, now: 3_000 })).toBe(4_000)
  })
})
