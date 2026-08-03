import { describe, expect, it } from "vitest"
import { toAgentInstanceId } from "../ids"
import { flueHistoryToSessionData, jaredConversationUrl } from "../flue-dispatch"

describe("toAgentInstanceId", () => {
  it("matches Flue conversation ids used for sandbox prep and agent attachment", () => {
    expect(toAgentInstanceId("getsentry/cli#1107")).toBe("getsentry-cli-1107")
    expect(toAgentInstanceId("sentry/project#abc")).toBe("sentry-project-abc")
  })

  it("is stable under lowercase + trailing junk", () => {
    expect(toAgentInstanceId("Getsentry/CLI#1107")).toBe("getsentry-cli-1107")
    expect(toAgentInstanceId("owner/repo#1!")).toBe("owner-repo-1")
  })
})

describe("flue-dispatch helpers", () => {
  it("builds a conversation URL with the shared instance id", () => {
    expect(jaredConversationUrl("https://jared.example.com/", "owner/repo#issue-1")).toBe(
      "https://jared.example.com/agents/jared/owner-repo-issue-1",
    )
  })

  it("normalizes Flue history into the dashboard session blob", () => {
    const blob = JSON.parse(
      flueHistoryToSessionData("acme/app#42", {
        messages: [{ role: "user", body: "hello", id: "m1" }],
      }),
    ) as {
      flue: boolean
      sessions: Array<{ id: string; agent: string }>
      messages: Record<string, Array<{ info?: { role?: string }; parts?: unknown[] }>>
    }

    expect(blob.flue).toBe(true)
    expect(blob.sessions[0]?.id).toBe("acme-app-42")
    expect(blob.sessions[0]?.agent).toBe("jared")
    expect(blob.messages["acme-app-42"]).toHaveLength(1)
    expect(blob.messages["acme-app-42"][0]?.info?.role).toBe("user")
    expect(blob.messages["acme-app-42"][0]?.parts).toEqual([{ type: "text", text: "hello" }])
  })
})
