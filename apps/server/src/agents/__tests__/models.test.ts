import { describe, expect, it } from "vitest"
import { Models, modelForDelivery } from "../../agents/models.ts"

describe("agent model tiers", () => {
  it("keeps the heavy primary on Opus and offers a cheaper light primary", () => {
    expect(Models.triage).toContain("claude-opus-4.8")
    expect(Models.triageLight).toMatch(/x-ai\//)
    expect(Models.triage).not.toBe(Models.triageLight)
  })

  it("uses balanced-cost models for explore/implement/ship", () => {
    expect(Models.explore).toContain("openai/gpt-5-mini")
    expect(Models.implement).toContain("moonshotai/")
    expect(Models.ship).toMatch(/x-ai\//)
  })

  it("all ids are OpenRouter-prefixed", () => {
    for (const id of Object.values(Models)) {
      expect(id.startsWith("openrouter/")).toBe(true)
    }
  })

  it("does not reference the delisted grok-code-fast-1 slug", () => {
    expect(Models.ship).not.toContain("grok-code-fast-1")
  })
})

describe("modelForDelivery", () => {
  it("uses the light primary when the event is tagged light", () => {
    const body = "New webhook event: pull_request_review.submitted\n<!-- jared:model-tier=light -->\n..."
    expect(modelForDelivery({ kind: "user", body })).toBe(Models.triageLight)
  })

  it("uses the heavy primary when the event is tagged heavy", () => {
    const body = "New webhook event: issues.labeled\n<!-- jared:model-tier=heavy -->\n..."
    expect(modelForDelivery({ kind: "user", body })).toBe(Models.triage)
  })

  it("defaults to the heavy primary when the marker is missing", () => {
    expect(modelForDelivery({ kind: "user", body: "no marker here" })).toBe(Models.triage)
  })

  it("defaults to the heavy primary for signals (scheduled follow-ups)", () => {
    expect(modelForDelivery({ kind: "signal", body: "jared:model-tier=light" })).toBe(Models.triage)
  })
})
