import { describe, expect, it } from "vitest"
import { classifyModelTier, isDurableExecutionRequest } from "../model-tier"

const json = (o: unknown) => JSON.stringify(o)

describe("classifyModelTier", () => {
  it("keeps durable repository actions distinct from status-only questions", () => {
    expect(isDurableExecutionRequest("Please fix the failing CI job.")).toBe(true)
    expect(isDurableExecutionRequest("Please investigate the failing CI job and report the findings.")).toBe(false)
  })

  it("routes every admitted comment and review event through Opus", () => {
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
    expect(
      classifyModelTier(
        "issue_comment",
        "edited",
        json({ issue: { pull_request: {} }, comment: { body: "Deployment complete", user: { login: "bot[bot]" } } }),
      ),
    ).toBe("heavy")
    expect(classifyModelTier("pull_request_review", "submitted", json({ review: { id: 1 } }))).toBe("heavy")
    expect(classifyModelTier("pull_request_review_comment", "created", json({}))).toBe("heavy")
    expect(classifyModelTier("pull_request_review_thread", "resolved", json({}))).toBe("heavy")
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
    expect(classifyModelTier("check_suite", "requested", json({ check_suite: { conclusion: "success" } }))).toBe(
      "heavy",
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
