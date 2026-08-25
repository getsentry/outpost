import { describe, expect, it, vi } from "vitest"
import type { GitHubApp } from "../app"
import { acknowledgeGitHubEvent, ackTarget } from "../reactions"

describe("ackTarget", () => {
  it("does not acknowledge a PR comment explicitly addressed to someone else", () => {
    expect(
      ackTarget(
        "issue_comment",
        "created",
        {
          comment: { id: 42, body: "@octocat could you take this?" },
          issue: { pull_request: {} },
        },
        "jared[bot]",
      ),
    ).toBeNull()
  })

  it("acknowledges a PR comment that also mentions Jared", () => {
    expect(
      ackTarget(
        "issue_comment",
        "created",
        {
          comment: { id: 42, body: "@jared[bot] and @octocat could you take this?" },
          issue: { pull_request: {} },
        },
        "jared[bot]",
      ),
    ).toEqual({ kind: "issueComment", id: 42 })
  })

  it("acknowledges an issue comment directed at a helper", () => {
    expect(
      ackTarget(
        "issue_comment",
        "created",
        {
          comment: { id: 42, body: "@octocat could you help Jared with this?" },
          issue: {},
        },
        "jared[bot]",
      ),
    ).toEqual({ kind: "issueComment", id: 42 })
  })

  it("does not acknowledge an approval-only review", () => {
    expect(
      ackTarget(
        "pull_request_review",
        "submitted",
        {
          pull_request: { number: 7 },
          review: { state: "approved" },
        },
        "jared[bot]",
      ),
    ).toBeNull()
  })
})

describe("acknowledgeGitHubEvent", () => {
  it("uses the issue-comment endpoint for a top-level PR comment", async () => {
    const createForIssue = vi.fn()
    const createForIssueComment = vi.fn().mockResolvedValue(undefined)
    const createForPullRequestReviewComment = vi.fn()
    const app = {
      getInstallationOctokit: vi.fn(() => ({
        reactions: { createForIssue, createForIssueComment, createForPullRequestReviewComment },
      })),
    } as unknown as GitHubApp

    await acknowledgeGitHubEvent({
      app,
      installationId: 1,
      repo: "getsentry/outpost",
      event: "issue_comment",
      action: "created",
      payload: { comment: { id: 42, body: "please fix this" }, issue: { pull_request: {} } },
      botLogin: "jared[bot]",
    })

    expect(createForIssueComment).toHaveBeenCalledWith({
      owner: "getsentry",
      repo: "outpost",
      comment_id: 42,
      content: "eyes",
    })
    expect(createForIssue).not.toHaveBeenCalled()
    expect(createForPullRequestReviewComment).not.toHaveBeenCalled()
  })
})
