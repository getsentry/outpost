import { describe, expect, it } from "vitest"
import { classifyModelTier, isExecutionRequest } from "../model-tier"

const json = (o: unknown) => JSON.stringify(o)

describe("classifyModelTier", () => {
  it("recognizes explicit operator work without treating a status question as execution", () => {
    expect(isExecutionRequest("Please investigate the failing CI job and propose a fix.")).toBe(true)
    expect(isExecutionRequest("What is the status of this PR?")).toBe(false)
  })

  it("marks PR review activity as light (respond-to-comment)", () => {
    expect(classifyModelTier("pull_request_review", "submitted", json({ review: { id: 1 } }))).toBe("light")
    expect(classifyModelTier("pull_request_review_comment", "created", json({}))).toBe("light")
    expect(classifyModelTier("pull_request_review_thread", "resolved", json({}))).toBe("light")
  })

  it("keeps imperative PR comments on the heavy execution path", () => {
    expect(
      classifyModelTier(
        "issue_comment",
        "created",
        json({
          issue: { pull_request: {} },
          comment: { body: "Please fix the review findings and update this PR." },
        }),
      ),
    ).toBe("heavy")
  })

  it("keeps clearly informational PR comments on the light reply path", () => {
    expect(
      classifyModelTier(
        "issue_comment",
        "created",
        json({ issue: { pull_request: {} }, comment: { body: "What is the expected release date?" } }),
      ),
    ).toBe("light")
  })

  it("routes issue comments to the heavy execution path", () => {
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
