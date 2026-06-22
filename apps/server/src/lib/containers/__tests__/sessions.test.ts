import { describe, expect, it } from "vitest"
import { mergeSessionData } from "../sessions"

type Parsed = {
  sessions: Array<Record<string, unknown>>
  sessionStatus: Record<string, { type?: string }>
  messages: Record<string, Array<{ info?: { id?: string }; parts?: unknown[] }>>
  logs?: string
}

const parse = (raw: string) => JSON.parse(raw) as Parsed

describe("mergeSessionData", () => {
  it("preserves a prior session when a recreated container reports a new session id", () => {
    const oldRaw = JSON.stringify({
      sessions: [{ id: "ses_old", title: "t", cost: 16, time: { updated: 100 } }],
      sessionStatus: {},
      messages: { ses_old: [{ info: { id: "m1" }, parts: [{}, {}] }] },
      logs: "",
    })
    const newRaw = JSON.stringify({
      sessions: [{ id: "ses_new", title: "t", cost: 7, time: { updated: 200 } }],
      sessionStatus: {},
      messages: { ses_new: [{ info: { id: "m2" }, parts: [{}] }] },
      logs: "",
    })

    const merged = parse(mergeSessionData(oldRaw, newRaw))

    // Both sessions survive, so cost/messages aggregate across recreations.
    expect(merged.sessions.map((s) => s.id)).toEqual(["ses_old", "ses_new"])
    expect(Object.keys(merged.messages).sort()).toEqual(["ses_new", "ses_old"])
    expect(merged.messages.ses_old).toHaveLength(1)
    expect(merged.messages.ses_new).toHaveLength(1)
  })

  it("keeps the richer snapshot for a session present in both blobs", () => {
    const oldRaw = JSON.stringify({
      sessions: [{ id: "ses_a", cost: 5, time: { updated: 100 } }],
      sessionStatus: {},
      messages: {},
    })
    // A partial re-report blanks cost — must not clobber the populated old one.
    const newRaw = JSON.stringify({
      sessions: [{ id: "ses_a", cost: 0, time: { updated: 50 } }],
      sessionStatus: {},
      messages: {},
    })

    const merged = parse(mergeSessionData(oldRaw, newRaw))

    expect(merged.sessions).toHaveLength(1)
    expect(merged.sessions[0].cost).toBe(5)
  })

  it("merges messages by id, keeping the version with more parts", () => {
    const oldRaw = JSON.stringify({
      sessions: [{ id: "ses_a" }],
      sessionStatus: {},
      messages: { ses_a: [{ info: { id: "m1" }, parts: [{}, {}, {}] }] },
    })
    const newRaw = JSON.stringify({
      sessions: [{ id: "ses_a" }],
      sessionStatus: {},
      messages: { ses_a: [{ info: { id: "m1" }, parts: [] }] },
    })

    const merged = parse(mergeSessionData(oldRaw, newRaw))

    expect(merged.messages.ses_a).toHaveLength(1)
    expect(merged.messages.ses_a[0].parts).toHaveLength(3)
  })

  it("forces a non-busy status for sessions absent from the latest sync", () => {
    const oldRaw = JSON.stringify({
      sessions: [{ id: "ses_old" }],
      sessionStatus: { ses_old: { type: "busy" } },
      messages: {},
    })
    const newRaw = JSON.stringify({
      sessions: [{ id: "ses_new" }],
      sessionStatus: { ses_new: { type: "busy" } },
      messages: {},
    })

    const merged = parse(mergeSessionData(oldRaw, newRaw))

    // The dead session must not keep a permanent "busy" spinner.
    expect(merged.sessionStatus.ses_old.type).toBe("idle")
    expect(merged.sessionStatus.ses_new.type).toBe("busy")
  })

  it("returns the new blob unchanged when the old blob is unparseable", () => {
    const newRaw = JSON.stringify({ sessions: [{ id: "ses_a" }], sessionStatus: {}, messages: {} })
    expect(mergeSessionData("not json", newRaw)).toBe(newRaw)
  })
})
