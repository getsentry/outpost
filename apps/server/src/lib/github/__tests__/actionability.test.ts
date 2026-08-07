import { describe, expect, it } from "vitest"
import { classifyCiEvent, isCiEvent } from "../actionability"

const withRun = (event: "workflow_run" | "check_suite", fields: Record<string, unknown>) => ({
  [event]: fields,
})

describe("isCiEvent", () => {
  it("matches only the noisy CI lifecycle event types", () => {
    expect(isCiEvent("workflow_run")).toBe(true)
    expect(isCiEvent("check_suite")).toBe(true)
    expect(isCiEvent("issues")).toBe(false)
    expect(isCiEvent("pull_request")).toBe(false)
    expect(isCiEvent("push")).toBe(false)
  })
})

describe("classifyCiEvent", () => {
  it("drops non-completed lifecycle events (requested / in_progress)", () => {
    for (const action of ["requested", "in_progress", "rerequested"]) {
      const v = classifyCiEvent("workflow_run", action, withRun("workflow_run", { conclusion: null }))
      expect(v).toEqual({ actionable: false, reason: "ci_incomplete" })
    }
  })

  it("drops completed runs with a non-actionable conclusion", () => {
    for (const conclusion of ["cancelled", "skipped", "neutral", "stale", "timed_out", "action_required", null]) {
      const v = classifyCiEvent(
        "check_suite",
        "completed",
        withRun("check_suite", { conclusion, pull_requests: [{ number: 1 }] }),
      )
      expect(v).toEqual({ actionable: false, reason: "ci_not_actionable" })
    }
  })

  it("drops completed failure/success runs not attached to a PR", () => {
    const v = classifyCiEvent(
      "workflow_run",
      "completed",
      withRun("workflow_run", { conclusion: "failure", pull_requests: [] }),
    )
    expect(v).toEqual({ actionable: false, reason: "ci_no_pr" })
  })

  it("keeps completed failure and success runs on a PR", () => {
    expect(
      classifyCiEvent(
        "workflow_run",
        "completed",
        withRun("workflow_run", { conclusion: "failure", pull_requests: [{ number: 7 }] }),
      ),
    ).toEqual({ actionable: true, conclusion: "failure" })
    expect(
      classifyCiEvent(
        "check_suite",
        "completed",
        withRun("check_suite", { conclusion: "success", pull_requests: [{ number: 7 }] }),
      ),
    ).toEqual({ actionable: true, conclusion: "success" })
  })
})
