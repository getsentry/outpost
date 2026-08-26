import { describe, expect, it } from "vitest"
import { DISCUSSION_RETRY_DELAY_MS, shouldRetryDiscussion } from "../discussion-retry"

describe("shouldRetryDiscussion", () => {
  const now = Date.UTC(2026, 7, 26, 12, 0, 0)

  it("requeues an open obligation Jared has not been reminded about recently", () => {
    expect(shouldRetryDiscussion({ status: "open", reminderCount: 0, lastRemindedAt: null }, now)).toBe(true)
    expect(
      shouldRetryDiscussion(
        { status: "open", reminderCount: 1, lastRemindedAt: new Date(now - DISCUSSION_RETRY_DELAY_MS) },
        now,
      ),
    ).toBe(true)
  })

  it("does not loop closed, recently reminded, or repeatedly missed obligations", () => {
    expect(shouldRetryDiscussion({ status: "verified", reminderCount: 0, lastRemindedAt: null }, now)).toBe(false)
    expect(shouldRetryDiscussion({ status: "open", reminderCount: 1, lastRemindedAt: new Date(now - 1) }, now)).toBe(
      false,
    )
    expect(shouldRetryDiscussion({ status: "open", reminderCount: 3, lastRemindedAt: null }, now)).toBe(false)
  })
})
