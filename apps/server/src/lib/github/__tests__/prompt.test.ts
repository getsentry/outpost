import { describe, expect, it } from "vitest"
import { formatEventPrompt } from "../prompt"

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
      pull_request: { number: 1108 },
      review: { id: 555 },
      comment: { id: 999, path: "src/foo.ts" },
    })
    const out = formatEventPrompt({ ...baseOpts, event: "pull_request_review_comment", payload })

    expect(out).toContain("This is a PR review event")
    expect(out).toContain("do NOT post a top-level PR comment")
    expect(out).toContain("PR number: 1108")
    expect(out).toContain("Inline comment id: 999")
    expect(out).toContain("File: src/foo.ts")
    expect(out).toContain("resolveReviewThread")
  })

  it("does not add review guidance for non-review events", () => {
    const payload = JSON.stringify({ check_suite: { conclusion: "success" } })
    const out = formatEventPrompt({ ...baseOpts, event: "check_suite", action: "completed", payload })

    expect(out).not.toContain("This is a PR review event")
    expect(out).toContain("New webhook event: check_suite.completed")
  })

  it("still emits review guidance when the payload is unparseable", () => {
    const out = formatEventPrompt({ ...baseOpts, event: "pull_request_review", payload: "not json" })
    expect(out).toContain("This is a PR review event")
    // No id lines, but the workflow guidance is still present.
    expect(out).toContain("Reply inline on the specific review thread")
  })
})
