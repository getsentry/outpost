import { describe, expect, it } from "vitest"
import { classifyModelTier } from "../model-tier"

const json = (o: unknown) => JSON.stringify(o)

describe("classifyModelTier", () => {
  it("marks PR review activity as light (respond-to-comment)", () => {
    expect(classifyModelTier("pull_request_review", "submitted", json({ review: { id: 1 } }))).toBe("light")
    expect(classifyModelTier("pull_request_review_comment", "created", json({}))).toBe("light")
    expect(classifyModelTier("pull_request_review_thread", "resolved", json({}))).toBe("light")
  })

  it("routes issue_comment by PR-vs-issue", () => {
    // Comment on a PR → respond-to-comment (light)
    expect(classifyModelTier("issue_comment", "created", json({ issue: { pull_request: {} } }))).toBe("light")
    // Comment on a plain issue → resolve-issue (heavy)
    expect(classifyModelTier("issue_comment", "created", json({ issue: {} }))).toBe("heavy")
  })

  it("splits CI events by conclusion", () => {
    // success → mark-pr-ready (light)
    expect(classifyModelTier("check_suite", "completed", json({ check_suite: { conclusion: "success" } }))).toBe(
      "light",
    )
    expect(classifyModelTier("workflow_run", "completed", json({ workflow_run: { conclusion: "success" } }))).toBe(
      "light",
    )
    // failure → fix-ci (heavy)
    expect(classifyModelTier("check_suite", "completed", json({ check_suite: { conclusion: "failure" } }))).toBe(
      "heavy",
    )
  })

  it("treats issue labeling and PR open as heavy", () => {
    expect(classifyModelTier("issues", "labeled", json({ label: { name: "jared" } }))).toBe("heavy")
    expect(classifyModelTier("pull_request", "opened", json({ pull_request: { number: 1 } }))).toBe("heavy")
  })

  it("defaults to heavy on unparseable payloads", () => {
    expect(classifyModelTier("issue_comment", "created", "not json")).toBe("heavy")
  })
})
