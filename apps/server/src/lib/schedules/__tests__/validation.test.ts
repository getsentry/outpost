import { describe, expect, it } from "vitest"
import { parseScheduleInput } from "../validation"

const base = {
  name: "Weekly dependency maintenance",
  repo: "sentry-internal/jared",
  prompt: "Check for dependency updates.",
  cadence: "weekly",
  time: "09:30",
  timezone: "Asia/Kolkata",
  dayOfWeek: 1,
  enabled: true,
}

describe("parseScheduleInput", () => {
  it("accepts guided recurrence input", () => {
    expect(parseScheduleInput(base)).toMatchObject(base)
  })

  it("rejects a recurrence missing its cadence-specific selector", () => {
    expect(() => parseScheduleInput({ ...base, dayOfWeek: undefined })).toThrow("dayOfWeek")
  })

  it("rejects an invalid IANA timezone", () => {
    expect(() => parseScheduleInput({ ...base, timezone: "Mars/Olympus" })).toThrow("timezone")
  })
})
