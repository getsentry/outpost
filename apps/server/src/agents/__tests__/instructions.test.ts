import { describe, expect, it } from "vitest"
import { JARED_INSTRUCTIONS } from "../instructions.ts"

describe("Jared autonomy contract", () => {
  it("finishes bounded fixes on its own PR without asking for permission", () => {
    expect(JARED_INSTRUCTIONS).toMatch(/finish\s+the full bounded change without asking for permission/)
    expect(JARED_INSTRUCTIONS).toContain("Do not offer a patch, instructions, or a menu")
    expect(JARED_INSTRUCTIONS).toMatch(
      /implement → validate →\s+review → commit → push → reply\/resolve → re-request review/,
    )
  })
})
