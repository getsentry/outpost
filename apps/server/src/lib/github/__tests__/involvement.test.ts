import { describe, expect, it } from "vitest"
import { deriveGitHubInvolvement, shouldAdmitGitHubEvent } from "../involvement"

describe("deriveGitHubInvolvement", () => {
  it("recognizes Jared as the requested reviewer on an unlabelled PR", () => {
    const involvement = deriveGitHubInvolvement(
      "pull_request",
      {
        action: "review_requested",
        pull_request: {
          number: 42,
          user: { login: "contributor" },
          requested_reviewers: [{ login: "jared-outpost[bot]" }],
        },
        requested_reviewer: { login: "jared-outpost[bot]" },
      },
      "jared-outpost[bot]",
    )

    expect(involvement).toEqual({ author: false, reviewer: true, mentioned: false })
  })

  it("recognizes a direct mention on an unlabelled PR comment", () => {
    const involvement = deriveGitHubInvolvement(
      "issue_comment",
      {
        action: "created",
        issue: { number: 42, pull_request: {}, user: { login: "contributor" } },
        comment: { body: "@jared-outpost[bot] could you add the missing test?" },
      },
      "jared-outpost[bot]",
    )

    expect(involvement).toEqual({ author: false, reviewer: false, mentioned: true })
  })

  it("does not mistake a longer login for a Jared mention", () => {
    const involvement = deriveGitHubInvolvement(
      "issue_comment",
      {
        issue: { number: 42, pull_request: {} },
        comment: { body: "@jared-outpost-helper please take this" },
      },
      "jared-outpost[bot]",
    )

    expect(involvement.mentioned).toBe(false)
  })

  it("does not treat an assignee as a requested reviewer", () => {
    const involvement = deriveGitHubInvolvement(
      "pull_request",
      {
        pull_request: { number: 42, user: { login: "contributor" }, assignees: [{ login: "jared-outpost[bot]" }] },
        assignee: { login: "jared-outpost[bot]" },
      },
      "jared-outpost[bot]",
    )

    expect(involvement.reviewer).toBe(false)
  })
})

describe("shouldAdmitGitHubEvent", () => {
  it("admits an unlabelled PR when Jared is a requested reviewer", () => {
    expect(
      shouldAdmitGitHubEvent({
        event: "pull_request",
        action: "review_requested",
        hasTriggerLabel: false,
        involvement: { author: false, reviewer: true, mentioned: false },
      }),
    ).toBe(true)
  })

  it("admits an unlabelled PR comment that directly mentions Jared", () => {
    expect(
      shouldAdmitGitHubEvent({
        event: "issue_comment",
        action: "created",
        hasTriggerLabel: false,
        involvement: { author: false, reviewer: false, mentioned: true },
      }),
    ).toBe(true)
  })

  it("continues to reject an unlabelled event with no Jared involvement", () => {
    expect(
      shouldAdmitGitHubEvent({
        event: "issue_comment",
        action: "created",
        hasTriggerLabel: false,
        involvement: { author: false, reviewer: false, mentioned: false },
      }),
    ).toBe(false)
  })

  it("does not re-admit a persistent PR-body mention on later lifecycle events", () => {
    expect(
      shouldAdmitGitHubEvent({
        event: "pull_request",
        action: "synchronize",
        hasTriggerLabel: false,
        involvement: { author: false, reviewer: false, mentioned: true },
      }),
    ).toBe(false)
  })
})
