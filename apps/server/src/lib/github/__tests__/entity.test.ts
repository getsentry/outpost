import { describe, expect, it } from "vitest"
import { extractEntityKey } from "../entity"

const base = {
  repository: { full_name: "getsentry/cli" },
}

describe("extractEntityKey — review events", () => {
  it("extracts an entity for pull_request_review_thread (previously dropped)", async () => {
    const payload = {
      ...base,
      pull_request: { number: 1108, body: "Closes #1107" },
      thread: { node_id: "PRRT_abc" },
    }
    const result = await extractEntityKey("pull_request_review_thread", payload)
    // Links back to the originating issue so the review reuses its container.
    expect(result?.key).toBe("getsentry/cli#1107")
    expect(result?.kind).toBe("issue")
  })

  it("keys a review thread to the PR when the body has no linked issue", async () => {
    const payload = {
      ...base,
      pull_request: { number: 1108, body: "no linking keyword here" },
      thread: { node_id: "PRRT_abc" },
    }
    const result = await extractEntityKey("pull_request_review_thread", payload)
    expect(result?.key).toBe("getsentry/cli#1108")
    expect(result?.kind).toBe("pull_request")
  })

  it("still extracts pull_request_review and pull_request_review_comment", async () => {
    const payload = { ...base, pull_request: { number: 1108, body: "Fixes #1107" } }
    expect((await extractEntityKey("pull_request_review", payload))?.key).toBe("getsentry/cli#1107")
    expect((await extractEntityKey("pull_request_review_comment", payload))?.key).toBe("getsentry/cli#1107")
  })
})
