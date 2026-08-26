import { describe, expect, it } from "vitest"
import { makeDiscussionRecord } from "../discussion-store"

describe("makeDiscussionRecord", () => {
  it("uses the GitHub comment identity as the deduplication key while retaining the exact obligation", () => {
    const record = makeDiscussionRecord({
      eventId: "delivery-1",
      entityKey: "getsentry/cli#1482",
      repo: "getsentry/cli",
      installationId: 42,
      obligation: {
        kind: "inline",
        prNumber: 1484,
        sourceCommentId: "102",
        replyToCommentId: "99",
        author: "MathurAditya724",
        body: "Jared, what happened to it?",
        url: "https://github.com/getsentry/cli/pull/1484#discussion_r102",
        createdAt: "2026-08-26T13:30:32Z",
      },
      now: new Date("2026-08-26T13:31:00Z"),
    })

    expect(record).toMatchObject({
      repo: "getsentry/cli",
      sourceCommentId: "102",
      status: "open",
      entityKey: "getsentry/cli#1482",
      sourceKind: "inline",
      replyToCommentId: "99",
      eventId: "delivery-1",
    })
    expect(record.id).toMatch(/^[a-f0-9-]{36}$/)
  })
})
