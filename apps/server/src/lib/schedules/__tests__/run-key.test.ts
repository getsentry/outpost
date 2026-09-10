import { describe, expect, it } from "vitest"
import { parseOwnerRepo } from "@/lib/containers/do-prep"
import { toAgentInstanceId } from "@/lib/containers/ids"
import { createScheduledEntityKey, scheduledRunMarker } from "../run-key"

describe("scheduled run keys", () => {
  it("keeps a fresh run isolated while preserving its repository identity", () => {
    const key = createScheduledEntityKey("sentry-internal/jared", "0f7c7917-bacf-4116-9c1f-33d7bc90b03e")

    expect(parseOwnerRepo(key)).toEqual({ owner: "sentry-internal", repo: "jared", slug: "sentry-internal/jared" })
    expect(key).toMatch(/^sentry-internal\/jared#s-[0-9a-f]{12}$/)
    expect(toAgentInstanceId(key)).toHaveLength(key.length)
  })

  it("uses opaque metadata that can associate a GitHub artifact without granting authority", () => {
    expect(scheduledRunMarker("run-123")).toBe("<!-- jared:schedule-run=run-123 -->")
  })
})
