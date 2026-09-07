import { describe, expect, it } from "vitest"
import { mayRunFollowUpFromRecord, nextGenerationAfterStart } from "../lifecycle"

describe("agent lifecycle generation", () => {
  it("rejects a scheduled follow-up after its generation is destroyed", () => {
    expect(mayRunFollowUpFromRecord({ generation: 3, destroyedAt: new Date("2026-09-07T00:00:00Z") }, 3)).toBe(false)
  })

  it("accepts a follow-up from the active generation", () => {
    expect(mayRunFollowUpFromRecord({ generation: 4, destroyedAt: null }, 4)).toBe(true)
  })

  it("starts a new generation when an entity is recreated after destruction", () => {
    expect(nextGenerationAfterStart({ generation: 4, destroyedAt: new Date("2026-09-07T00:00:00Z") })).toBe(5)
    expect(nextGenerationAfterStart({ generation: 4, destroyedAt: null })).toBe(4)
  })
})
