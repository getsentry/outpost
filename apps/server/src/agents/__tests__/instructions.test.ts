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

  it("treats a concrete reviewer request as an instruction rather than a scope debate", () => {
    const respondToComment = readFileSync(
      new URL("../../../container/skills/respond-to-comment/SKILL.md", import.meta.url),
      "utf8",
    )

    expect(respondToComment).toContain("Default to **doing what the reviewer asked.**")
    expect(respondToComment).toContain("Never argue the same point twice.")
    expect(respondToComment).toContain("reviewThreads(first:100,after:$endCursor)")
    expect(JARED_INSTRUCTIONS).toMatch(/acting on the feedback, not\s+defending your choices/)
  })

  it("requires evidence before calling CI failures pre-existing or closing a failing PR", () => {
    const fixCi = readFileSync(new URL("../../../container/skills/fix-ci/SKILL.md", import.meta.url), "utf8")

    expect(fixCi).toContain("Never call a failure pre-existing or unrelated without evidence.")
    expect(fixCi).toContain("latest default branch")
    expect(fixCi).toContain("Never close a PR or say it is ready while required checks are failing.")
  })

  it("does not miss review threads or re-request review before required checks are green", () => {
    const respondToComment = readFileSync(
      new URL("../../../container/skills/respond-to-comment/SKILL.md", import.meta.url),
      "utf8",
    )

    expect(respondToComment).toContain("gh api graphql --paginate")
    expect(respondToComment).toContain("gh pr checks <N>")
    expect(respondToComment).toContain("Do not re-request review or describe the PR as ready")
  })

  it("does not bypass the required-check gate after completing review fixes", () => {
    const respondToComment = readFileSync(
      new URL("../../../container/skills/respond-to-comment/SKILL.md", import.meta.url),
      "utf8",
    )

    expect(respondToComment).toContain("After all fixes, request review only after required checks are green.")
  })

  it("captures external check output when no GitHub Actions log exists", () => {
    const fixCi = readFileSync(new URL("../../../container/skills/fix-ci/SKILL.md", import.meta.url), "utf8")

    expect(fixCi).toContain("commits/<SHA>/check-runs")
    expect(fixCi).toContain("gh run view returns 404")
  })

  it("keeps the canonical CI specification aligned with evidence-first recovery", () => {
    const fixCiSpec = readFileSync(new URL("../../../container/skills/fix-ci/SPEC.md", import.meta.url), "utf8")

    expect(fixCiSpec).toMatch(/diagnostic trail,\s+not a hard stop/)
    expect(fixCiSpec).toContain("latest default branch")
    expect(fixCiSpec).toContain("available log or check output")
    expect(fixCiSpec).toContain("Never close or mark the PR ready while required checks are failing")
  })
})
