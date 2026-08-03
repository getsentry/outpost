import { describe, expect, it } from "vitest"
import { Models } from "../../agents/models.ts"

describe("agent model tiers", () => {
  it("keeps triage on Opus 4.8 and implementation on Opus 4.6", () => {
    expect(Models.triage).toContain("claude-opus-4.8")
    expect(Models.implement).toContain("claude-opus-4.6")
    expect(Models.triage).not.toBe(Models.implement)
  })

  it("uses Sonnet for explore and an xAI model for ship", () => {
    expect(Models.explore).toContain("claude-sonnet")
    expect(Models.ship).toMatch(/x-ai\//)
  })
})
