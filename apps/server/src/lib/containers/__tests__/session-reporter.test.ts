import type { getSandbox } from "@cloudflare/sandbox"
import { expect, it, vi } from "vitest"
import { ensureSandboxReady } from "../dispatch"
import { verifySessionIngestToken } from "../session-ingest-token"

it("restarts a missing reporter on a warm sandbox with the current generation", async () => {
  const writeFile = vi.fn(async (_path: string, _body: string) => {})
  const startProcess = vi.fn(async () => {})
  const sandbox = {
    exec: vi.fn(async (command: string) => ({
      success: !command.includes("pgrep -f 'session-reporter.sh'"),
      stdout: "",
      stderr: "",
    })),
    writeFile,
    startProcess,
    setEnvVars: vi.fn(async () => {}),
  } as unknown as ReturnType<typeof getSandbox>
  await ensureSandboxReady(sandbox, {
    repo: "acme/app",
    entityKey: "acme/app#42",
    botLogin: "bot",
    installationToken: "test-token",
    appUrl: "https://example.test",
    flueInternalToken: "test-secret",
    sessionGeneration: 2,
  })
  const script = writeFile.mock.calls.find(([path]) => path.includes("session-reporter.sh"))?.[1]
  expect(script).toBeDefined()
  const token = script!.match(/INGEST_TOKEN='([^']+)'/)?.[1]
  expect(await verifySessionIngestToken("test-secret", token!, "acme/app#42", 2)).toBe(true)
  expect(startProcess).toHaveBeenCalledOnce()
})
