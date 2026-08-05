import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { buildPhase1BootstrapScript, type SandboxSetupOpts } from "../dispatch"

const baseOpts: SandboxSetupOpts = {
  repo: "getsentry/cli",
  botLogin: "jared-agent[bot]",
  installationToken: "ghs_exampletoken1234567890",
  entityKey: "getsentry/cli#1365",
  appUrl: "https://jared.getsentry.workers.dev",
}

function renderToFile(opts: SandboxSetupOpts): string {
  const script = buildPhase1BootstrapScript(opts)
  const dir = mkdtempSync(join(tmpdir(), "flue-bootstrap-"))
  const path = join(dir, "bootstrap.sh")
  writeFileSync(path, script)
  return path
}

describe("buildPhase1BootstrapScript", () => {
  it("produces syntactically valid bash (bash -n)", () => {
    const path = renderToFile(baseOpts)
    // Throws (non-zero exit) if bash finds a syntax error.
    expect(() => execFileSync("bash", ["-n", path])).not.toThrow()
  })

  it("stays valid with tricky repo/bot values", () => {
    const path = renderToFile({
      ...baseOpts,
      repo: "acme/repo-with-dash",
      botLogin: "some bot",
      installationToken: "",
    })
    expect(() => execFileSync("bash", ["-n", path])).not.toThrow()
  })

  it("clones via a temp dir + atomic rename and never pre-creates /workspace/repo", () => {
    const script = buildPhase1BootstrapScript(baseOpts)
    expect(script).toContain("git clone --depth 50")
    expect(script).toContain("/workspace/repo-tmp")
    expect(script).toContain("mv /workspace/repo-tmp /workspace/repo")
    expect(script).not.toContain("mkdir -p /workspace/repo\n")
  })

  it("starts Flue in the background so the process returns immediately", () => {
    const script = buildPhase1BootstrapScript(baseOpts)
    expect(script).toContain("cd /opt/flue && node dist/server.mjs")
    // Flue + keepalive must be detached (& backgrounded), else the bootstrap blocks.
    expect(script).toMatch(/node dist\/server\.mjs[^\n]*\) &/)
  })

  it("embeds the install token into the clone URL and GH_TOKEN", () => {
    const script = buildPhase1BootstrapScript(baseOpts)
    expect(script).toContain("x-access-token:ghs_exampletoken1234567890@github.com/getsentry/cli.git")
    expect(script).toContain("export GH_TOKEN=")
  })
})
