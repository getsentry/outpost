import { describe, expect, it } from "vitest"
import { extractEventContext, formatEventPrompt } from "../prompt"

const baseOpts = {
  action: "submitted" as string | null,
  deliveryId: "d-1",
  sender: "reviewer",
  repo: "getsentry/cli",
  entityKey: "getsentry/cli#1107",
  botLogin: "jared-outpost[bot]",
}

describe("formatEventPrompt — review guidance", () => {
  it("adds review guidance and surfaces comment ids for review events", () => {
    const payload = JSON.stringify({
      pull_request: { number: 1108, title: "Fix foo", body: "details", user: { login: "alice" } },
      review: { id: 555, state: "changes_requested", user: { login: "reviewer" } },
      comment: { id: 999, path: "src/foo.ts", body: "please fix" },
    })
    const out = formatEventPrompt({ ...baseOpts, event: "pull_request_review_comment", payload })

    expect(out).toContain("This is a PR review event")
    expect(out).toContain("do NOT post a top-level PR comment")
    expect(out).toContain("PR number: 1108")
    expect(out).toContain("Inline comment id: 999")
    expect(out).toContain("File: src/foo.ts")
    expect(out).toContain("resolveReviewThread")
    expect(out).toContain("PR #1108: Fix foo")
    expect(out).toContain("please fix")
    // Full raw JSON dump must not appear.
    expect(out).not.toContain("```json")
  })

  it("does not add review guidance for non-review events", () => {
    const payload = JSON.stringify({
      check_suite: { conclusion: "success", status: "completed", head_sha: "abc123", head_branch: "main" },
    })
    const out = formatEventPrompt({ ...baseOpts, event: "check_suite", action: "completed", payload })

    expect(out).not.toContain("This is a PR review event")
    expect(out).toContain("New webhook event: check_suite.completed")
    expect(out).toContain("Conclusion: success")
    expect(out).toContain("SHA: abc123")
    expect(out).not.toContain("```json")
  })

  it("still emits review guidance when the payload is unparseable", () => {
    const out = formatEventPrompt({ ...baseOpts, event: "pull_request_review", payload: "not json" })
    expect(out).toContain("This is a PR review event")
    expect(out).toContain("Reply inline on the specific review thread")
    expect(out).toContain("payload unparseable")
  })

  it("truncates long issue bodies", () => {
    const body = "x".repeat(5000)
    const payload = JSON.stringify({ issue: { number: 1, title: "Big", body, user: { login: "a" } } })
    const ctx = extractEventContext("issues", payload)
    expect(ctx).toContain("truncated")
    expect(ctx.length).toBeLessThan(body.length)
  })
})
