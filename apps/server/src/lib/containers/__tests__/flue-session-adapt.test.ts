import { describe, expect, it } from "vitest"
import { flueHistoryToSessionData } from "../flue-session-adapt"
import { deriveDisplayStatus } from "../sessions"

describe("flueHistoryToSessionData", () => {
  it.each([
    ["failed", "failed"],
    ["aborted", "interrupted"],
  ])("preserves %s settlements as %s in the dashboard", (outcome, expected) => {
    const raw = flueHistoryToSessionData("getsentry/cli#42", {
      messages: [{ role: "user", submissionId: "one", parts: [] }],
      settlements: [{ submissionId: "one", outcome, error: { type: "submission_timeout" } }],
    })
    expect(JSON.parse(raw).sessionStatus["getsentry-cli-42"].type).toBe(expected)
    expect(deriveDisplayStatus(raw, 0)).toBe(expected)
  })

  it("displays a workspace-lost settlement as blocked, not idle or historical", () => {
    const raw = flueHistoryToSessionData("getsentry/cli#42", {
      messages: [{ role: "user", submissionId: "one", parts: [] }],
      settlements: [{ submissionId: "one", outcome: "failed", error: { type: "workspace_lost" } }],
    })
    expect(JSON.parse(raw).sessionStatus["getsentry-cli-42"].type).toBe("blocked")
    expect(deriveDisplayStatus(raw, 0)).toBe("blocked")
  })

  it("clears an old blocker once a newer delivery has completed", () => {
    const raw = flueHistoryToSessionData("getsentry/cli#42", {
      messages: [
        { role: "user", submissionId: "one", parts: [] },
        { role: "user", submissionId: "two", parts: [] },
      ],
      settlements: [
        { submissionId: "one", outcome: "failed", error: { type: "workspace_lost" } },
        { submissionId: "two", outcome: "completed" },
      ],
    })
    expect(JSON.parse(raw).sessionStatus["getsentry-cli-42"].type).toBe("idle")
  })
  it("bounds oversized dynamic-tool output while retaining its original size", () => {
    const raw = flueHistoryToSessionData("getsentry/cli#42", {
      messages: [
        {
          id: "m1",
          role: "assistant",
          parts: [
            {
              type: "dynamic-tool",
              toolName: "bash",
              state: "output-available",
              output: "x".repeat(20_000),
            },
          ],
        },
      ],
      settlements: [],
    })
    const output = JSON.parse(raw).messages["getsentry-cli-42"][0].parts[0].state.output

    expect(output).toMatchObject({ truncated: true, originalBytes: 20_000 })
    expect(output.preview).toHaveLength(8_000)
  })

  it("preserves small tool output unchanged", () => {
    const raw = flueHistoryToSessionData("getsentry/cli#42", {
      messages: [
        {
          id: "m1",
          role: "assistant",
          parts: [{ type: "dynamic-tool", toolName: "bash", state: "output-available", output: "ok" }],
        },
      ],
      settlements: [],
    })

    expect(JSON.parse(raw).messages["getsentry-cli-42"][0].parts[0].state.output).toBe("ok")
  })
})
