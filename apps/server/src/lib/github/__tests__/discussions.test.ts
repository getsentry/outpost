import { describe, expect, it } from "vitest"
import {
  extractDiscussionObligation,
  extractDiscussionPrNumber,
  formatDiscussionInbox,
  parseDiscussionResponseMarker,
  responseEvidenceFromWebhook,
  responseMatchesDiscussion,
} from "../discussions"

describe("extractDiscussionObligation", () => {
  it("keeps a human top-level PR request as a reply obligation", () => {
    const obligation = extractDiscussionObligation(
      "issue_comment",
      "created",
      {
        issue: { number: 1484, pull_request: {} },
        comment: {
          id: 101,
          body: "Could we rename this flag?",
          user: { login: "maintainer", type: "User" },
          html_url: "https://github.com/getsentry/cli/pull/1484#issuecomment-101",
          created_at: "2026-08-26T09:59:31Z",
        },
      },
      "jared-outpost[bot]",
    )

    expect(obligation).toMatchObject({
      kind: "top_level",
      sourceCommentId: "101",
      prNumber: 1484,
      author: "maintainer",
      body: "Could we rename this flag?",
    })
  })

  it("keeps an inline reviewer follow-up as its own obligation", () => {
    const obligation = extractDiscussionObligation(
      "pull_request_review_comment",
      "created",
      {
        pull_request: { number: 1484 },
        comment: {
          id: 102,
          in_reply_to_id: 99,
          body: "Jared, what happened to it?",
          user: { login: "MathurAditya724", type: "User" },
          html_url: "https://github.com/getsentry/cli/pull/1484#discussion_r102",
          created_at: "2026-08-26T13:30:32Z",
        },
      },
      "jared-outpost[bot]",
    )

    expect(obligation).toMatchObject({
      kind: "inline",
      sourceCommentId: "102",
      replyToCommentId: "99",
      body: "Jared, what happened to it?",
    })
  })

  it("does not create an obligation for Jared's own reply or an integration status message", () => {
    const ownReply = extractDiscussionObligation(
      "issue_comment",
      "created",
      {
        issue: { number: 1484, pull_request: {} },
        comment: { id: 103, body: "Fixed in abc123.", user: { login: "jared-outpost[bot]", type: "Bot" } },
      },
      "jared-outpost[bot]",
    )
    const integration = extractDiscussionObligation(
      "issue_comment",
      "created",
      {
        issue: { number: 1484, pull_request: {} },
        comment: { id: 104, body: "Deployment succeeded.", user: { login: "vercel", type: "Bot" } },
      },
      "jared-outpost[bot]",
    )

    expect(ownReply).toBeNull()
    expect(integration).toBeNull()
  })

  it("does not turn deleted comments or dismissed reviews into work Jared owes", () => {
    expect(
      extractDiscussionObligation(
        "issue_comment",
        "deleted",
        {
          issue: { number: 1484, pull_request: {} },
          comment: { id: 101, body: "removed", user: { login: "maintainer" } },
        },
        "jared-outpost[bot]",
      ),
    ).toBeNull()
    expect(
      extractDiscussionObligation(
        "pull_request_review",
        "dismissed",
        { pull_request: { number: 1484 }, review: { id: 101, body: "dismissed", user: { login: "maintainer" } } },
        "jared-outpost[bot]",
      ),
    ).toBeNull()
  })
})

describe("extractDiscussionPrNumber", () => {
  it("uses the actual PR from a CI event rather than the shared linked-issue session", () => {
    expect(
      extractDiscussionPrNumber("check_suite", {
        check_suite: { pull_requests: [{ number: 1484 }] },
      }),
    ).toBe(1484)
  })
})

describe("parseDiscussionResponseMarker", () => {
  it("reads a hidden outcome marker without constraining the visible reply", () => {
    expect(
      parseDiscussionResponseMarker(
        "The defaults command should show it too.\n<!-- jared-discussion:abc123:needs-human -->",
      ),
    ).toEqual({ obligationId: "abc123", outcome: "needs-human" })
  })

  it("rejects unrelated comments and unsupported outcomes", () => {
    expect(parseDiscussionResponseMarker("I looked into it.")).toBeNull()
    expect(parseDiscussionResponseMarker("<!-- jared-discussion:abc123:done -->")).toBeNull()
  })
})

describe("formatDiscussionInbox", () => {
  it("requires a considered response to every open discussion without prescribing its wording", () => {
    const inbox = formatDiscussionInbox([
      {
        id: "abc123",
        kind: "top_level",
        author: "BYK",
        body: "Could we rename all sixel flags?",
        url: "https://github.com/getsentry/cli/pull/1484#issuecomment-101",
      },
      {
        id: "def456",
        kind: "inline",
        author: "MathurAditya724",
        body: "Jared, what happened to it?",
        url: "https://github.com/getsentry/cli/pull/1484#discussion_r102",
      },
    ])

    expect(inbox).toContain("2 open discussion obligations")
    expect(inbox).toContain("Could we rename all sixel flags?")
    expect(inbox).toContain("Jared, what happened to it?")
    expect(inbox).toContain("<!-- jared-discussion:abc123:<outcome> -->")
    expect(inbox).toContain("do not send a generic acknowledgement")
  })
})

describe("responseEvidenceFromWebhook", () => {
  it("accepts a marker only from Jared's actual GitHub reply", () => {
    const evidence = responseEvidenceFromWebhook(
      "pull_request_review_comment",
      {
        pull_request: { number: 1484 },
        comment: {
          in_reply_to_id: 102,
          body: "The UI path needs the matching row too.\n<!-- jared-discussion:abc123:explained -->",
        },
      },
      "jared-outpost[bot]",
      "jared-outpost[bot]",
    )

    expect(evidence).toEqual({
      obligationId: "abc123",
      outcome: "explained",
      prNumber: 1484,
      replyToCommentId: "102",
    })
  })

  it("does not let another user close an obligation by copying a marker", () => {
    const evidence = responseEvidenceFromWebhook(
      "issue_comment",
      { comment: { body: "<!-- jared-discussion:abc123:addressed -->" } },
      "maintainer",
      "jared-outpost[bot]",
    )

    expect(evidence).toBeNull()
  })

  it("requires visible content besides the marker", () => {
    const evidence = responseEvidenceFromWebhook(
      "issue_comment",
      {
        issue: { number: 1484, pull_request: {} },
        comment: { body: "<!-- jared-discussion:abc123:addressed -->" },
      },
      "jared-outpost[bot]",
      "jared-outpost[bot]",
    )

    expect(evidence).toBeNull()
  })

  it("requires an inline response to be on the obligation's specific comment", () => {
    const matches = responseMatchesDiscussion(
      { kind: "inline", prNumber: 1484, sourceCommentId: "102" },
      { obligationId: "abc123", outcome: "addressed", prNumber: 1484, replyToCommentId: "99" },
    )

    expect(matches).toBe(false)
  })

  it("only accepts a response for the same pull request and exact inline parent", () => {
    const response = { obligationId: "abc123", outcome: "addressed" as const, prNumber: 1484, replyToCommentId: "102" }

    expect(responseMatchesDiscussion({ kind: "inline", prNumber: 1484, sourceCommentId: "102" }, response)).toBe(true)
    expect(responseMatchesDiscussion({ kind: "inline", prNumber: 1485, sourceCommentId: "102" }, response)).toBe(false)
  })
})
