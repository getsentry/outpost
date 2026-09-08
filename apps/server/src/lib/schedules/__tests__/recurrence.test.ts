import { describe, expect, it } from "vitest"
import { nextOccurrences } from "../recurrence"

describe("nextOccurrences", () => {
  it("keeps a daily schedule at the same local time across daylight saving time", () => {
    const occurrences = nextOccurrences(
      { cadence: "daily", time: "09:30", timezone: "America/New_York" },
      "2026-03-07T15:00:00Z",
      3,
    )

    expect(occurrences).toEqual(["2026-03-08T13:30:00Z", "2026-03-09T13:30:00Z", "2026-03-10T13:30:00Z"])
  })

  it("runs monthly day 31 on the final day of short months", () => {
    const occurrences = nextOccurrences(
      { cadence: "monthly", time: "10:00", timezone: "UTC", dayOfMonth: 31 },
      "2026-04-01T00:00:00Z",
      2,
    )

    expect(occurrences).toEqual(["2026-04-30T10:00:00Z", "2026-05-31T10:00:00Z"])
  })
})
