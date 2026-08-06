#!/usr/bin/env node
/**
 * Generate the runtime skill tree (`.agents/skills/`) from the canonical
 * authoring tree (`skills/`).
 *
 * There is exactly ONE source of truth for Jared's skills: `container/skills/`.
 * It holds each skill's `SKILL.md`, any `references/` it links to, and (for some)
 * an authoring-only `SPEC.md`. The Dockerfiles bake `.agents/skills/` into the
 * image, and the Worker copies that tree into the cloned repo at runtime — but
 * Flue only discovers skills under `.agents/skills/`, so the runtime tree has to
 * be a faithful copy of the source MINUS the authoring-only `SPEC.md`.
 *
 * Historically the two trees were hand-mirrored and shipped only `SKILL.md`,
 * which silently dropped the `references/` files that `review` and `fix-ci`
 * link to — an agent following those skills literally hit dead paths. This
 * script makes the runtime tree deterministic and lets CI fail on drift.
 *
 * Usage:
 *   node container/scripts/sync-skills.mjs           # write .agents/skills/
 *   node container/scripts/sync-skills.mjs --check    # exit 1 if out of date
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
export const CONTAINER_DIR = join(HERE, "..")
export const SOURCE_DIR = join(CONTAINER_DIR, "skills")
export const RUNTIME_DIR = join(CONTAINER_DIR, ".agents", "skills")

/**
 * Files that stay in the authoring tree only and are never shipped to the
 * sandbox. `SPEC.md` is design intent for humans, not an agent-facing skill.
 */
const AUTHORING_ONLY = new Set(["SPEC.md"])

/** List every file under `dir`, recursively, as paths relative to `dir`. */
function walk(dir, base = dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full, base))
    else if (entry.isFile()) out.push(relative(base, full))
  }
  return out
}

/**
 * The runtime skill tree we expect on disk: a map of path (relative to
 * `RUNTIME_DIR`) → file contents, derived from the canonical `skills/` tree.
 */
export function expectedRuntimeFiles() {
  const files = new Map()
  for (const skill of readdirSync(SOURCE_DIR, { withFileTypes: true })) {
    if (!skill.isDirectory()) continue
    const skillDir = join(SOURCE_DIR, skill.name)
    for (const rel of walk(skillDir)) {
      // rel is relative to the skill dir, e.g. "SKILL.md" or "references/x.md".
      if (AUTHORING_ONLY.has(rel)) continue
      files.set(join(skill.name, rel), readFileSync(join(skillDir, rel), "utf8"))
    }
  }
  return files
}

/** Diff the on-disk runtime tree against what `skills/` should produce. */
export function findDrift() {
  const expected = expectedRuntimeFiles()
  const drift = { missing: [], mismatched: [], extra: [] }

  for (const [rel, content] of expected) {
    const target = join(RUNTIME_DIR, rel)
    if (!existsSync(target)) drift.missing.push(rel)
    else if (readFileSync(target, "utf8") !== content) drift.mismatched.push(rel)
  }

  if (existsSync(RUNTIME_DIR)) {
    for (const rel of walk(RUNTIME_DIR)) {
      if (!expected.has(rel)) drift.extra.push(rel)
    }
  }
  return drift
}

/** Rewrite `.agents/skills/` so it exactly matches the canonical source. */
export function writeRuntime() {
  rmSync(RUNTIME_DIR, { recursive: true, force: true })
  for (const [rel, content] of expectedRuntimeFiles()) {
    const target = join(RUNTIME_DIR, rel)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
}

function main() {
  const check = process.argv.includes("--check")
  if (check) {
    const drift = findDrift()
    const problems = [
      ...drift.missing.map((f) => `missing ${f}`),
      ...drift.mismatched.map((f) => `stale ${f}`),
      ...drift.extra.map((f) => `extra ${f}`),
    ]
    if (problems.length > 0) {
      console.error("container/.agents/skills is out of date with container/skills:")
      for (const p of problems) console.error(`  - ${p}`)
      console.error("\nRun `pnpm --filter @jared/server sync:skills` and commit the result.")
      process.exit(1)
    }
    console.log(`skills in sync (${expectedRuntimeFiles().size} files)`) // eslint-disable-line no-console
    return
  }
  writeRuntime()
  console.log(`synced ${expectedRuntimeFiles().size} files → ${relative(process.cwd(), RUNTIME_DIR)}`) // eslint-disable-line no-console
}

// Only run the CLI when invoked directly, not when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}
