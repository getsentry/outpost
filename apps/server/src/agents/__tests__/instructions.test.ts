import { readFileSync } from "node:fs"
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

  it("executes acknowledged fixes while retaining its safety boundaries", () => {
    expect(JARED_INSTRUCTIONS).toMatch(/“yes”, “do it”,\s+or “take control”/)
    expect(JARED_INSTRUCTIONS).toContain("Never push to or force-push the default branch")
    expect(JARED_INSTRUCTIONS).toContain("Don't touch CI config, secrets, or lockfiles unless specifically asked")

    const respondToComment = readFileSync(
      new URL("../../../container/skills/respond-to-comment/SKILL.md", import.meta.url),
      "utf8",
    )
    expect(respondToComment).toContain("Do not ask whether to push")
    expect(respondToComment).toMatch(/means execute\s+the fix now, not propose it again/)
    expect(respondToComment).toContain("Don't merge")
  })

  it("treats its own jared-label follow-up as a work trigger", () => {
    expect(JARED_INSTRUCTIONS).toMatch(
      /EXCEPT for[\s\S]*`issues\.labeled` event whose[\s\S]*`payload\.label\.name` is `jared`/,
    )
  })
})
