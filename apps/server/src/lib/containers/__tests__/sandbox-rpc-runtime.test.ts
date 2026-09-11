import { fileURLToPath, URL } from "node:url"
import { build } from "esbuild"
import { Log, LogLevel, Miniflare } from "miniflare"
import { afterEach, beforeAll, describe, expect, it } from "vitest"

let script: string
const runtimes: Miniflare[] = []
beforeAll(async () => {
  const output = await build({
    entryPoints: [fileURLToPath(new URL("../../../__tests__/fixtures/sandbox-rpc-worker.ts", import.meta.url))],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    external: ["cloudflare:*"],
    logLevel: "silent",
  })
  script = output.outputFiles[0].text
})
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()))
})

function createRuntime() {
  const runtime = new Miniflare({
    modules: [{ type: "ESModule", path: "sandbox-rpc-worker.mjs", contents: script }],
    compatibilityDate: "2026-06-01",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { Sandbox: { className: "ResettableSandbox", useSQLite: true } },
    log: new Log(LogLevel.NONE),
  })
  runtimes.push(runtime)
  return runtime
}

describe("Sandbox connections across real Workers RPC resets", () => {
  it("reproduces the SDK command environment being lost on DO reset", async () => {
    const runtime = createRuntime()
    expect(await (await runtime.dispatchFetch("https://test/volatile-env")).json()).toEqual({
      before: true,
      after: false,
    })
  }, 30_000)

  it("reproduces a permanently broken stub and reconnects without replaying a write", async () => {
    const runtime = createRuntime()
    expect(await (await runtime.dispatchFetch("https://test/stale")).json()).toEqual({
      rejected: true,
      broken: true,
      count: 1,
    })
    expect(await (await runtime.dispatchFetch("https://test/fresh")).json()).toEqual({
      rejected: true,
      broken: false,
      count: 1,
    })
  }, 30_000)

  it.each([
    { mode: "original", connectionsBeforeCall: 1 },
    { mode: "fresh", connectionsBeforeCall: 0 },
  ])("preserves SDK configuration order and exec options with the $mode client", async ({
    mode,
    connectionsBeforeCall,
  }) => {
    const runtime = createRuntime()
    expect(await (await runtime.dispatchFetch(`https://test/sdk-${mode}`)).json()).toEqual({
      connectionsBeforeCall,
      connections: 1,
      names: [`sdk-${mode}`],
      nonThenable: true,
      command: "probe",
      sessionToken: "__DISABLE_SESSION__",
      options: {
        cwd: "/review",
        timeout: 123,
        ...(mode === "fresh" ? { env: { BASH_ENV: "/tmp/jared-github-env.sh" } } : {}),
      },
      configuration: { sandboxName: { name: `sdk-${mode}`, normalizeId: true }, sleepAfter: "10m" },
    })
  }, 30_000)
})
