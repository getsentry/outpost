import { describe, expect, it } from "vitest"
import { admittedStatus, settledSubmissionIds, submissionIdFromAdmittedStatus } from "../delivery-status"

describe("delivery status", () => {
  it("records the exact Flue submission that admitted a delivery", () => {
    expect(admittedStatus("sub-42")).toBe("admitted:sub-42")
    expect(submissionIdFromAdmittedStatus("admitted:sub-42")).toBe("sub-42")
  })

  it("does not invent a submission id when Flue omits a receipt", () => {
    expect(admittedStatus()).toBe("admitted")
    expect(submissionIdFromAdmittedStatus("admitted")).toBeNull()
  })

  it("extracts only settled submission ids from Flue history", () => {
    expect(
      settledSubmissionIds({
        settlements: [
          { submissionId: "sub-42", outcome: "completed" },
          { submissionId: "sub-99", outcome: "failed" },
          { outcome: "completed" },
        ],
      }),
    ).toEqual(new Set(["sub-42", "sub-99"]))
  })
})
