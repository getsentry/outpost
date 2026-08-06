import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { JARED_INSTRUCTIONS } from "@/agents/instructions"
// The sync tool is plain ESM shared with the CLI, so the test proves exactly
// what CI/build ship rather than re-deriving the layout.
import { expectedRuntimeFiles, findDrift, RUNTIME_DIR, SOURCE_DIR } from "../../../../container/scripts/sync-skills.mjs"

describe("container skill sync", () => {
  it("has a committed runtime tree that matches the canonical skills/ source", () => {
    // If this fails, run `pnpm -F @jared/server sync:skills` and commit.
    const drift = findDrift()
    expect(drift.missing, "missing runtime files").toEqual([])
    expect(drift.mismatched, "stale runtime files").toEqual([])
    expect(drift.extra, "orphan runtime files").toEqual([])
  })

  it("ships the reference files that review/fix-ci link to (regression guard)", () => {
    // These were silently dropped when the runtime tree only copied SKILL.md.
    const required = [
      "review/references/confidence-calibration.md",
      "review/references/not-a-finding.md",
      "fix-ci/references/failure-taxonomy.md",
    ]
    for (const rel of required) {
      expect(existsSync(join(RUNTIME_DIR, rel)), `runtime missing ${rel}`).toBe(true)
    }
  })

  it("never ships authoring-only SPEC.md into the sandbox", () => {
    for (const rel of expectedRuntimeFiles().keys()) {
      expect(rel.endsWith("SPEC.md"), `SPEC.md leaked to runtime: ${rel}`).toBe(false)
    }
  })

  it("keeps Jared's referenced skills and the runtime inventory in agreement", () => {
    const runtimeSkills = readdirSync(RUNTIME_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()

    // Every skill Jared names in its instructions must exist on disk...
    const backticked = new Set([...JARED_INSTRUCTIONS.matchAll(/`([a-z][a-z-]+)`/g)].map((m) => m[1]))
    const referenced = runtimeSkills.filter((name) => backticked.has(name))
    for (const name of runtimeSkills) {
      expect(referenced, `skill '${name}' exists but is never referenced in JARED_INSTRUCTIONS`).toContain(name)
    }

    // ...and the source and runtime skill dirs are the same set.
    const sourceSkills = readdirSync(SOURCE_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
    expect(runtimeSkills).toEqual(sourceSkills)
  })
})
