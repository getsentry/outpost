import { describe, expect, it } from "vitest"
import { flueHistoryToSessionData } from "../flue-session-adapt"

describe("flueHistoryToSessionData", () => {
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
