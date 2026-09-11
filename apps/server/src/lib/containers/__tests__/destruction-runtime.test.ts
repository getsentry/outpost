import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, URL } from "node:url"
import { build } from "esbuild"
import { Log, LogLevel, Miniflare } from "miniflare"
import { afterEach, beforeAll, describe, expect, it } from "vitest"

const root = fileURLToPath(new URL("../../../../", import.meta.url))
let script: string
const runtimes: Miniflare[] = []
beforeAll(async () => {
  const output = await build({
    entryPoints: [path.join(root, "src/__tests__/fixtures/destruction-worker.ts")],
    absWorkingDir: root,
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    mainFields: ["module", "main"],
    external: ["cloudflare:*", "node:*"],
    conditions: ["workerd", "worker"],
    logLevel: "silent",
    banner: {
      js: 'import { createRequire } from "node:module"; const require = createRequire("/destruction-worker.mjs");',
    },
  })
  script = output.outputFiles[0].text
}, 30_000)

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()))
})

async function fixture(mode = "after-delete") {
  const runtime = new Miniflare({
    modules: [{ type: "ESModule", path: "destruction-worker.mjs", contents: script }],
    compatibilityDate: "2026-06-01",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: {
      FLUE_JARED_AGENT: { className: "TestAgent", useSQLite: true },
      Sandbox: { className: "TestSandbox", useSQLite: true },
    },
    d1Databases: ["DB"],
    bindings: { FLUE_NATIVE: "1", SENTRY_TRACES_SAMPLE_RATE: "0" },
    log: new Log(LogLevel.NONE),
  })
  runtimes.push(runtime)
  const db = await runtime.getD1Database("DB")
  const migrations = path.join(root, "migrations")
  for (const file of readdirSync(migrations)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    for (const statement of readFileSync(path.join(migrations, file), "utf8").split("--> statement-breakpoint")) {
      if (statement.trim()) await db.prepare(statement).run()
    }
  }
  const seed = await runtime.dispatchFetch(`https://test/seed?mode=${mode}`)
  expect(seed.status).toBe(200)
  return { runtime, db }
}

describe("Destroy across real Workers RPC shutdown", () => {
  it.each(["after-delete", "normal-reply"])("finishes Sandbox and D1 cleanup with SDK shutdown %s", async (mode) => {
    const { runtime, db } = await fixture(mode)
    const response = await runtime.dispatchFetch("https://test/destroy")
    expect(await response.json()).toEqual({ ok: true })
    expect(response.status).toBe(200)
    expect(await (await runtime.dispatchFetch("https://test/state")).json()).toEqual({
      history: null,
      historyTable: false,
      alarm: null,
      sandboxDestroyed: true,
    })
    expect(await db.prepare("SELECT COUNT(*) AS count FROM agent_sessions").first("count")).toBe(0)
    expect(await db.prepare("SELECT cleanup_pending FROM agent_lifecycle").first("cleanup_pending")).toBe(0)
  }, 30_000)

  it.each([
    "before-delete",
    "without-delete",
    "reset-before-delete",
  ])("keeps cleanup blocked when destruction fails %s", async (mode) => {
    const { runtime, db } = await fixture(mode)
    const response = await runtime.dispatchFetch("https://test/destroy")
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: "Run cleanup failed during agent deletion" })
    const state = (await (await runtime.dispatchFetch("https://test/state")).json()) as Record<string, unknown>
    expect(state.history).toBe("old conversation")
    expect(state.historyTable).toBe(true)
    expect(state.sandboxDestroyed).toBe(false)
    expect(await db.prepare("SELECT COUNT(*) AS count FROM agent_sessions").first("count")).toBe(1)
    expect(await db.prepare("SELECT cleanup_pending FROM agent_lifecycle").first("cleanup_pending")).toBe(1)
  }, 30_000)

  it("requires the old instance to stop, even when its storage was cleared", async () => {
    const { runtime, db } = await fixture("without-reset")
    expect((await runtime.dispatchFetch("https://test/destroy")).status).toBe(503)
    const state = (await (await runtime.dispatchFetch("https://test/state")).json()) as Record<string, unknown>
    expect(state.history).toBeNull()
    expect(state.historyTable).toBe(false)
    expect(state.sandboxDestroyed).toBe(false)
    expect(await db.prepare("SELECT cleanup_pending FROM agent_lifecycle").first("cleanup_pending")).toBe(1)
  }, 30_000)

  it("allows retry after a failed deletion and then starts a clean generation", async () => {
    const { runtime, db } = await fixture("before-delete")
    expect((await runtime.dispatchFetch("https://test/destroy")).status).toBe(503)
    await runtime.dispatchFetch("https://test/recover")
    expect((await runtime.dispatchFetch("https://test/destroy")).status).toBe(200)
    expect(await db.prepare("SELECT cleanup_pending FROM agent_lifecycle").first("cleanup_pending")).toBe(0)
    const restarted = await runtime.dispatchFetch("https://test/seed")
    expect(await restarted.json()).toEqual({ generation: 2 })
    expect(await db.prepare("SELECT COUNT(*) AS count FROM agent_sessions").first("count")).toBe(1)
  }, 30_000)
})
