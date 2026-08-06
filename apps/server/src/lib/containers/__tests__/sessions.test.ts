import { describe, expect, it } from "vitest"
import {
  countSessionMessages,
  demoteBusyStatusesToIdle,
  deriveDisplayStatus,
  deriveOverallStatus,
  FRESH_BUSY_WITH_SYNC_ERROR_MS,
  HISTORICAL_IDLE_MS,
  isStaleBusy,
  mergeSessionData,
  STALE_BUSY_MS,
} from "../sessions"

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

  it("merges messages by top-level Flue id when info.id is absent", () => {
    const oldRaw = JSON.stringify({
      sessions: [{ id: "ses_a" }],
      sessionStatus: {},
      messages: { ses_a: [{ id: "m1", role: "user", parts: [{}, {}] }] },
    })
    const newRaw = JSON.stringify({
      sessions: [{ id: "ses_a" }],
      sessionStatus: {},
      messages: { ses_a: [{ id: "m1", role: "user", parts: [{}, {}, {}] }] },
    })

    const merged = parse(mergeSessionData(oldRaw, newRaw))

    expect(merged.messages.ses_a).toHaveLength(1)
    expect(merged.messages.ses_a[0].parts).toHaveLength(3)
  })

  it("drops pending-* placeholder sessions when a Flue sync arrives", () => {
    const oldRaw = JSON.stringify({
      sessions: [{ id: "pending-abc", title: "t" }],
      sessionStatus: { "pending-abc": { type: "busy" } },
      messages: {},
      flue: true,
    })
    const newRaw = JSON.stringify({
      sessions: [{ id: "owner-repo-1", title: "t", agent: "jared" }],
      sessionStatus: { "owner-repo-1": { type: "idle" } },
      messages: { "owner-repo-1": [{ info: { id: "m1" }, parts: [{}] }] },
      flue: true,
    })

    const merged = parse(mergeSessionData(oldRaw, newRaw))

    expect(merged.sessions.map((s) => s.id)).toEqual(["owner-repo-1"])
    expect(merged.sessionStatus["pending-abc"]).toBeUndefined()
    expect(merged.sessionStatus["owner-repo-1"]?.type).toBe("idle")
  })

  it("returns the new blob unchanged when the old blob is unparseable", () => {
    const newRaw = JSON.stringify({ sessions: [{ id: "ses_a" }], sessionStatus: {}, messages: {} })
    expect(mergeSessionData("not json", newRaw)).toBe(newRaw)
  })
})

describe("deriveOverallStatus", () => {
  it("returns busy when any child session is busy", () => {
    expect(
      deriveOverallStatus({
        sessionStatus: { a: { type: "idle" }, b: { type: "busy" } },
      }),
    ).toBe("busy")
  })

  it("returns idle when statuses exist and none are busy", () => {
    expect(
      deriveOverallStatus({
        sessionStatus: { a: { type: "idle" }, b: { type: "idle" } },
      }),
    ).toBe("idle")
  })

  it("returns unknown when there are no status entries", () => {
    expect(deriveOverallStatus({ sessionStatus: {} })).toBe("unknown")
    expect(deriveOverallStatus({})).toBe("unknown")
    expect(deriveOverallStatus("not json")).toBe("unknown")
  })
})

describe("countSessionMessages", () => {
  it("sums messages across session keys", () => {
    expect(
      countSessionMessages({
        messages: { a: [{}, {}], b: [{}] },
      }),
    ).toBe(3)
  })

  it("returns 0 for empty or unparseable blobs", () => {
    expect(countSessionMessages({})).toBe(0)
    expect(countSessionMessages("not json")).toBe(0)
  })
})

describe("deriveDisplayStatus", () => {
  const busy = { sessionStatus: { a: { type: "busy" } } }
  const idle = { sessionStatus: { a: { type: "idle" } } }
  const now = 1_700_000_000_000

  it("returns working for fresh busy without sync error", () => {
    expect(deriveDisplayStatus(busy, now - 60_000, { now })).toBe("working")
  })

  it("returns working for busy with sync error only when very fresh", () => {
    expect(
      deriveDisplayStatus(busy, now - FRESH_BUSY_WITH_SYNC_ERROR_MS + 1_000, {
        now,
        syncError: "timeout",
      }),
    ).toBe("working")
    expect(
      deriveDisplayStatus(busy, now - FRESH_BUSY_WITH_SYNC_ERROR_MS - 1_000, {
        now,
        syncError: "timeout",
      }),
    ).toBe("sync_unavailable")
  })

  it("returns sync_unavailable for stale busy", () => {
    expect(deriveDisplayStatus(busy, now - STALE_BUSY_MS - 1, { now })).toBe("sync_unavailable")
  })

  it("returns sync_unavailable when sync fails without idle confirmation", () => {
    expect(deriveDisplayStatus({}, now - 60_000, { now, syncError: "failed" })).toBe("sync_unavailable")
  })

  it("returns idle vs historical based on age", () => {
    expect(deriveDisplayStatus(idle, now - 60_000, { now })).toBe("idle")
    expect(deriveDisplayStatus(idle, now - HISTORICAL_IDLE_MS, { now })).toBe("historical")
  })

  it("keeps idle even when syncError is set (idle is confirmed)", () => {
    expect(deriveDisplayStatus(idle, now - 60_000, { now, syncError: "failed" })).toBe("idle")
  })

  it("returns unknown when there is no status and no sync error", () => {
    expect(deriveDisplayStatus({}, now, { now })).toBe("unknown")
  })
})

describe("demoteBusyStatusesToIdle / isStaleBusy", () => {
  it("detects stale busy snapshots", () => {
    const now = Date.now()
    expect(isStaleBusy({ sessionStatus: { a: { type: "busy" } } }, now - STALE_BUSY_MS - 1, now)).toBe(true)
    expect(isStaleBusy({ sessionStatus: { a: { type: "busy" } } }, now - 60_000, now)).toBe(false)
    expect(isStaleBusy({ sessionStatus: { a: { type: "idle" } } }, now - STALE_BUSY_MS - 1, now)).toBe(false)
  })

  it("rewrites busy sessionStatus entries to idle", () => {
    const raw = JSON.stringify({
      sessions: [{ id: "a" }],
      sessionStatus: { a: { type: "busy", reason: "placeholder" }, b: { type: "idle" } },
      messages: {},
    })
    const demoted = JSON.parse(demoteBusyStatusesToIdle(raw)) as Parsed
    expect(demoted.sessionStatus.a.type).toBe("idle")
    expect(demoted.sessionStatus.b.type).toBe("idle")
  })
})
