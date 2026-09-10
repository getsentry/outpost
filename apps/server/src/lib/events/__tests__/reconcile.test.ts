import { describe, expect, it } from "vitest"
import { decideReconciledStatus, settledStatusForAdmission } from "../reconcile"

describe("decideReconciledStatus", () => {
  it("marks settled only when the exact submission has a settlement", () => {
    const read = {
      ok: true as const,
      history: {
        messages: [{ role: "user", submissionId: "s1", parts: [] }],
        settlements: [{ submissionId: "s1", outcome: "completed" }],
      },
      offset: null,
    }
    expect(decideReconciledStatus(read, "s1")).toBe("settled")
  })

  it("keeps the timeout when the agent is still busy (open submission)", () => {
    const read = {
      ok: true as const,
      history: { messages: [{ role: "user", submissionId: "s1", parts: [] }], settlements: [] },
      offset: null,
    }
    expect(decideReconciledStatus(read, "s1")).toBe("failed:timeout")
  })

  it("keeps the timeout when history is unreadable (404 / recycled / error)", () => {
    expect(decideReconciledStatus({ ok: false, notFound: true, error: "not found" }, "s1")).toBe("failed:timeout")
    expect(decideReconciledStatus({ ok: false, notFound: false, error: "boom" }, "s1")).toBe("failed:timeout")
  })
})

describe("settledStatusForAdmission", () => {
  it.each([
    ["failed", { type: "workspace_lost" }, "failed:workspace_lost"],
    ["failed", { type: "internal_error" }, "failed:runtime"],
    ["aborted", undefined, "failed:aborted"],
  ])("preserves a %s receipt instead of labeling it settled", (outcome, error, expected) => {
    expect(
      settledStatusForAdmission(
        { ok: true, offset: null, history: { settlements: [{ submissionId: "one", outcome, error }] } },
        "one",
      ),
    ).toBe(expected)
  })
  const history = {
    messages: [
      { role: "user", submissionId: "sub-42", parts: [] },
      { role: "user", submissionId: "sub-99", parts: [] },
    ],
    settlements: [{ submissionId: "sub-42", outcome: "completed" }],
  }

  it("settles only the delivery whose submission settled", () => {
    expect(settledStatusForAdmission({ ok: true, history, offset: null }, "sub-42")).toBe("settled")
    expect(settledStatusForAdmission({ ok: true, history, offset: null }, "sub-99")).toBeNull()
  })

  it("does not turn an idle conversation into blanket completion", () => {
    expect(settledStatusForAdmission({ ok: true, history, offset: null }, "sub-99")).not.toBe("completed")
  })
})
