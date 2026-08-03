import { describe, expect, it } from "vitest"
import { flueHistoryToSessionData, jaredConversationUrl } from "../flue-dispatch"

describe("flue-dispatch helpers", () => {
  it("builds a stable conversation URL", () => {
    expect(jaredConversationUrl("https://jared.example.com/", "owner/repo#issue-1")).toBe(
      "https://jared.example.com/agents/jared/owner-repo-issue-1",
    )
  })

  it("normalizes Flue history into the dashboard session blob", () => {
    const blob = JSON.parse(
      flueHistoryToSessionData("acme/app#42", {
        messages: [{ kind: "user", body: "hello" }],
      }),
    ) as {
      flue: boolean
      sessions: Array<{ id: string; agent: string }>
      messages: Record<string, unknown[]>
    }

    expect(blob.flue).toBe(true)
    expect(blob.sessions[0]?.agent).toBe("jared")
    expect(blob.messages["acme-app-42"]).toHaveLength(1)
  })
})
