import { describe, expect, it } from "vitest"
import { ciStillRunning, classifyCiEvent, isCiEvent } from "../actionability"

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

describe("ciStillRunning", () => {
  it("is running while any check is queued / in progress", () => {
    for (const status of ["queued", "in_progress", "waiting", "requested", "pending"]) {
      expect(ciStillRunning([{ status: "completed" }, { status }], null)).toBe(true)
    }
  })

  it("is settled when every check has completed", () => {
    expect(ciStillRunning([{ status: "completed" }, { status: "completed" }], null)).toBe(false)
  })

  it("treats a pending combined legacy status (with reported statuses) as running", () => {
    expect(ciStillRunning([{ status: "completed" }], { state: "pending", total_count: 2 })).toBe(true)
  })

  it("ignores a pending combined status with no reported statuses (unknown SHA default)", () => {
    expect(ciStillRunning([{ status: "completed" }], { state: "pending", total_count: 0 })).toBe(false)
  })

  it("is settled on success/failure combined status", () => {
    expect(ciStillRunning([{ status: "completed" }], { state: "success", total_count: 3 })).toBe(false)
    expect(ciStillRunning([{ status: "completed" }], { state: "failure", total_count: 3 })).toBe(false)
  })

  it("is settled (fail-open) when there is no check data at all", () => {
    expect(ciStillRunning([], null)).toBe(false)
  })
})
