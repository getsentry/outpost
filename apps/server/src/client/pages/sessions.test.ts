import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import type { SessionListItem } from "@/client/lib/api"
import { sessionStatusBucket, sortSessionsByCreatedAt } from "./sessions.tsx"

const pageSource = readFileSync(new URL("./sessions.tsx", import.meta.url), "utf8")

describe("agent-runs ordering", () => {
  it("orders each visible page by immutable creation time, newest first", () => {
    const sessions = [
      { entityKey: "acme/older#1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-03T00:00:00.000Z" },
      { entityKey: "acme/newer#2", createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" },
    ] as SessionListItem[]

    expect(sortSessionsByCreatedAt(sessions).map((session) => session.entityKey)).toEqual([
      "acme/newer#2",
      "acme/older#1",
    ])
  })

  it("uses the entity key as a stable tie-breaker", () => {
    const sessions = [
      { entityKey: "acme/z#1", createdAt: "2026-01-01T00:00:00.000Z" },
      { entityKey: "acme/a#2", createdAt: "2026-01-01T00:00:00.000Z" },
    ] as SessionListItem[]

    expect(sortSessionsByCreatedAt(sessions).map((session) => session.entityKey)).toEqual(["acme/a#2", "acme/z#1"])
  })

  it("keeps the latest-activity column constrained", () => {
    expect(pageSource).toContain("w-[180px] min-w-[180px]")
    expect(pageSource).toContain('className="min-w-[940px] table-fixed"')
  })
})

describe("agent-runs status buckets", () => {
  it("maps working and its legacy busy value to the working bucket", () => {
    expect(sessionStatusBucket("working")).toBe("working")
    expect(sessionStatusBucket("busy")).toBe("working")
  })

  it("maps idle and historical to their own buckets", () => {
    expect(sessionStatusBucket("idle")).toBe("idle")
    expect(sessionStatusBucket("historical")).toBe("historical")
  })

  it("collapses unknown and attention states into offline", () => {
    expect(sessionStatusBucket("unknown")).toBe("offline")
    expect(sessionStatusBucket("failed")).toBe("offline")
    expect(sessionStatusBucket("sync_unavailable")).toBe("offline")
  })

  it("syncs the status filter to a URL search param", () => {
    expect(pageSource).toContain('searchParams.get("status")')
    expect(pageSource).toContain("setStatus")
  })
})
