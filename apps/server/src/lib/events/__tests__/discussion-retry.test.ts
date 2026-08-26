import { describe, expect, it, vi } from "vitest"

const { dispatchGitHubEvent } = vi.hoisted(() => ({ dispatchGitHubEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock("@/lib/github/dispatch", () => ({ dispatchGitHubEvent }))

import { DISCUSSION_RETRY_DELAY_MS, retryOpenDiscussionObligations, shouldRetryDiscussion } from "../discussion-retry"

describe("shouldRetryDiscussion", () => {
  const now = Date.UTC(2026, 7, 26, 12, 0, 0)

  it("requeues an open obligation only after the initial delivery has had time to complete", () => {
    expect(shouldRetryDiscussion({ status: "open", reminderCount: 0, lastRemindedAt: new Date(now - 1) }, now)).toBe(
      false,
    )
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

  it("retries one representative event per PR and atomically claims its whole inbox batch", async () => {
    const all = vi.fn().mockResolvedValue({
      results: [
        {
          id: "oldest",
          repo: "getsentry/cli",
          pr_number: 1484,
          entity_key: "getsentry/cli#1484",
          reminder_count: 0,
          last_reminded_at: Math.floor((now - DISCUSSION_RETRY_DELAY_MS) / 1000),
          status: "open",
          event_id: "event-1",
          event: "issue_comment",
          action: "created",
          delivery_id: "delivery-1",
          sender: "maintainer",
          event_repo: "getsentry/cli",
          installation_id: 42,
          payload: "{}",
        },
      ],
    })
    const run = vi.fn().mockResolvedValue({ meta: { changes: 2 } })
    const prepare = vi.fn((query: string) => ({
      bind: vi.fn(() => (query.startsWith("SELECT") ? { all } : { run })),
    }))

    const result = await retryOpenDiscussionObligations({ ENV: "test", DB: { prepare } } as never, now)

    expect(result).toEqual({ retried: 1, needsHuman: 0 })
    expect(dispatchGitHubEvent).toHaveBeenCalledTimes(1)
    expect(prepare.mock.calls[0]?.[0]).toContain("earlier.pr_number = o.pr_number")
    expect(prepare.mock.calls[1]?.[0]).toContain("WHERE repo = ? AND pr_number = ?")
  })
})
