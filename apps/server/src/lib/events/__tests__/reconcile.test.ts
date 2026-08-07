import { describe, expect, it } from "vitest"
import { decideReconciledStatus } from "../reconcile"

describe("decideReconciledStatus", () => {
  it("marks completed when the live agent is idle (work finished)", () => {
    const read = {
      ok: true as const,
      history: {
        messages: [{ role: "user", submissionId: "s1", parts: [] }],
        settlements: [{ submissionId: "s1", outcome: "completed" }],
      },
      offset: null,
    }
    expect(decideReconciledStatus(read)).toBe("completed")
  })

  it("keeps the timeout when the agent is still busy (open submission)", () => {
    const read = {
      ok: true as const,
      history: { messages: [{ role: "user", submissionId: "s1", parts: [] }], settlements: [] },
      offset: null,
    }
    expect(decideReconciledStatus(read)).toBe("failed:timeout")
  })

  it("keeps the timeout when history is unreadable (404 / recycled / error)", () => {
    expect(decideReconciledStatus({ ok: false, notFound: true, error: "not found" })).toBe("failed:timeout")
    expect(decideReconciledStatus({ ok: false, notFound: false, error: "boom" })).toBe("failed:timeout")
  })
})
