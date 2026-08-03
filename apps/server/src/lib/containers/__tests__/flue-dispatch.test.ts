import { describe, expect, it } from "vitest"
import { jaredConversationUrl } from "../flue-dispatch"
import {
  deriveFlueBusyStatus,
  flueHistoryToSessionData,
  normalizeFlueMessage,
  normalizeFlueSessionBlob,
} from "../flue-session-adapt"
import { toAgentInstanceId } from "../ids"

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
})

describe("flueHistoryToSessionData", () => {
  it("normalizes Flue history into the dashboard session blob", () => {
    const blob = JSON.parse(
      flueHistoryToSessionData("acme/app#42", {
        messages: [{ role: "user", body: "hello", id: "m1" }],
        settlements: [{ submissionId: "s1", outcome: "completed" }],
      }),
    ) as {
      flue: boolean
      sessions: Array<{ id: string; agent: string }>
      sessionStatus: Record<string, { type: string }>
      messages: Record<string, Array<{ info?: { role?: string }; parts?: unknown[] }>>
    }

    expect(blob.flue).toBe(true)
    expect(blob.sessions[0]?.id).toBe("acme-app-42")
    expect(blob.sessions[0]?.agent).toBe("jared")
    expect(blob.messages["acme-app-42"]).toHaveLength(1)
    expect(blob.messages["acme-app-42"][0]?.info?.role).toBe("user")
    expect(blob.messages["acme-app-42"][0]?.parts).toEqual([{ type: "text", text: "hello" }])
    expect(blob.sessionStatus["acme-app-42"]?.type).toBe("idle")
  })

  it("maps dynamic-tool parts into OpenCode-like tool parts", () => {
    const blob = JSON.parse(
      flueHistoryToSessionData("acme/app#1", {
        messages: [
          {
            id: "a1",
            role: "assistant",
            parts: [
              {
                type: "dynamic-tool",
                toolName: "bash",
                toolCallId: "tc1",
                state: "output-available",
                input: { cmd: "ls" },
                output: "ok",
              },
            ],
          },
        ],
        settlements: [{ submissionId: "s1", outcome: "completed" }],
      }),
    ) as {
      messages: Record<string, Array<{ parts?: Array<Record<string, unknown>> }>>
    }

    const part = blob.messages["acme-app-1"][0]?.parts?.[0]
    expect(part?.type).toBe("tool")
    expect(part?.tool).toBe("bash")
    expect(part?.state).toEqual({ status: "completed", input: { cmd: "ls" }, output: "ok" })
  })

  it("drops hidden Flue messages", () => {
    const blob = JSON.parse(
      flueHistoryToSessionData("acme/app#1", {
        messages: [
          { id: "h1", role: "system", display: "hidden", parts: [{ type: "text", text: "secret" }] },
          { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
        ],
        settlements: [],
      }),
    ) as { messages: Record<string, unknown[]> }

    expect(blob.messages["acme-app-1"]).toHaveLength(1)
  })

  it("marks busy when a submission is unsettled", () => {
    const blob = JSON.parse(
      flueHistoryToSessionData("acme/app#1", {
        messages: [{ id: "u1", role: "user", submissionId: "s-open", parts: [{ type: "text", text: "go" }] }],
        settlements: [],
      }),
    ) as { sessionStatus: Record<string, { type: string }> }

    expect(blob.sessionStatus["acme-app-1"]?.type).toBe("busy")
  })

  it("extracts cost from metadata.usage", () => {
    const msg = normalizeFlueMessage(
      {
        id: "a1",
        role: "assistant",
        parts: [{ type: "text", text: "done", state: "done" }],
        metadata: { usage: { cost: { total: 1.25 } }, model: "opus" },
      },
      0,
    )
    expect(msg?.info).toMatchObject({ cost: 1.25, modelID: "opus", role: "assistant" })
  })
})

describe("normalizeFlueSessionBlob", () => {
  it("rewrites raw Phase-1 reporter blobs into {info, parts}", () => {
    const raw = JSON.stringify({
      flue: true,
      sessions: [{ id: "acme-app-9", title: "acme-app-9", agent: "jared" }],
      sessionStatus: { "acme-app-9": { type: "busy" } },
      messages: {
        "acme-app-9": [{ id: "m1", role: "user", parts: [{ type: "text", text: "ping", state: "done" }] }],
      },
      logs: "boot",
      settlements: [{ submissionId: "s1", outcome: "completed" }],
    })

    const blob = JSON.parse(normalizeFlueSessionBlob("acme/app#9", raw)) as {
      messages: Record<string, Array<{ info?: { role?: string; id?: string } }>>
      sessionStatus: Record<string, { type: string }>
      logs: string
    }

    expect(blob.messages["acme-app-9"][0]?.info?.role).toBe("user")
    expect(blob.messages["acme-app-9"][0]?.info?.id).toBe("m1")
    expect(blob.logs).toBe("boot")
    expect(blob.sessionStatus["acme-app-9"]?.type).toBe("idle")
  })

  it("preserves busy on empty placeholder sessions", () => {
    const raw = JSON.stringify({
      flue: true,
      sessions: [{ id: "pending-abc", title: "acme/app#9", agent: "jared" }],
      sessionStatus: { "pending-abc": { type: "busy" } },
      messages: {},
    })
    const blob = JSON.parse(normalizeFlueSessionBlob("acme/app#9", raw)) as {
      sessions: Array<{ id: string }>
      sessionStatus: Record<string, { type: string }>
    }
    expect(blob.sessions[0]?.id).toBe("acme-app-9")
    expect(blob.sessionStatus["acme-app-9"]?.type).toBe("busy")
  })

  it("leaves non-flue blobs unchanged", () => {
    const raw = JSON.stringify({ sessions: [], sessionStatus: {}, messages: {} })
    expect(normalizeFlueSessionBlob("x", raw)).toBe(raw)
  })
})

describe("deriveFlueBusyStatus", () => {
  it("returns true for streaming text parts", () => {
    expect(
      deriveFlueBusyStatus([{ role: "assistant", parts: [{ type: "text", text: "hi", state: "streaming" }] }], []),
    ).toBe(true)
  })

  it("returns false when all submissions settled", () => {
    expect(
      deriveFlueBusyStatus(
        [{ role: "user", submissionId: "s1", parts: [{ type: "text", text: "hi", state: "done" }] }],
        [{ submissionId: "s1", outcome: "completed" }],
      ),
    ).toBe(false)
  })
})
