import { describe, expect, it } from "vitest"
import { ackTarget } from "../reactions"

describe("ackTarget", () => {
  it("targets the comment on a brand-new issue comment", () => {
    expect(ackTarget("issue_comment", "created", { comment: { id: 42 } })).toEqual({ kind: "issueComment", id: 42 })
  })

  it("targets the review comment on a new PR review comment", () => {
    expect(ackTarget("pull_request_review_comment", "created", { comment: { id: 7 } })).toEqual({
      kind: "reviewComment",
      id: 7,
    })
  })

  it("targets the issue when it is labeled / opened / reopened", () => {
    for (const action of ["labeled", "opened", "reopened"]) {
      expect(ackTarget("issues", action, { issue: { number: 5 } })).toEqual({ kind: "issue", number: 5 })
    }
  })

  it("targets the PR when a review is submitted", () => {
    expect(ackTarget("pull_request_review", "submitted", { pull_request: { number: 9 } })).toEqual({
      kind: "issue",
      number: 9,
    })
  })

  it("ignores CI, pushes, edits and deletions", () => {
    expect(ackTarget("workflow_run", "completed", {})).toBeNull()
    expect(ackTarget("push", null, {})).toBeNull()
    expect(ackTarget("issue_comment", "edited", { comment: { id: 1 } })).toBeNull()
    expect(ackTarget("issue_comment", "deleted", { comment: { id: 1 } })).toBeNull()
    expect(ackTarget("issues", "closed", { issue: { number: 1 } })).toBeNull()
  })

  it("is null when the id / number is missing", () => {
    expect(ackTarget("issue_comment", "created", {})).toBeNull()
    expect(ackTarget("issues", "labeled", {})).toBeNull()
    expect(ackTarget("pull_request_review", "submitted", {})).toBeNull()
  })
})
