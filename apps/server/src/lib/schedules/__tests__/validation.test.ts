import { describe, expect, it } from "vitest"
import { parseManualRunInput, parseScheduleInput } from "../validation"

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

describe("parseManualRunInput", () => {
  it("requires an explicit confirmation and bounded string idempotency key", () => {
    expect(parseManualRunInput({ confirm: true, idempotencyKey: "  run-123  " })).toEqual({
      confirm: true,
      idempotencyKey: "run-123",
    })
  })

  it("rejects malformed replay fences", () => {
    expect(() => parseManualRunInput({ confirm: true, idempotencyKey: {} })).toThrow()
    expect(() => parseManualRunInput({ confirm: true, idempotencyKey: "x".repeat(121) })).toThrow()
  })
})
