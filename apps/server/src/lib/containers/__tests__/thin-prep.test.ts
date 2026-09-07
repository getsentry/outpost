import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { buildThinSandboxPrepScript, type SandboxSetupOpts } from "../dispatch"

const baseOpts: SandboxSetupOpts = {
  repo: "getsentry/cli",
  botLogin: "jared-agent[bot]",
  installationToken: "ghs_exampletoken1234567890",
  entityKey: "getsentry/cli#1365",
  openaiApiKey: "openai-test-key",
}

function renderToFile(opts: SandboxSetupOpts): string {
  const dir = mkdtempSync(join(tmpdir(), "thin-prep-"))
  const path = join(dir, "prep.sh")
  writeFileSync(path, buildThinSandboxPrepScript(opts))
  return path
}

describe("buildThinSandboxPrepScript", () => {
  it("serializes clone, credentials, skills, and verification behind one lock", () => {
    const script = buildThinSandboxPrepScript(baseOpts)

    expect(script).toContain("LOCK=/workspace/.thin-sandbox-prep.lock")
    expect(script).toContain("trap cleanup EXIT")
    expect(script).toContain("git clone --depth 50")
    expect(script).toContain("gh auth login --with-token")
    expect(script).toContain("cp -R /root/.agents/skills")
    expect(script).toContain("test -d /workspace/repo/.git")
  })

  it("replaces the complete environment atomically with GitHub auth included", () => {
    const script = buildThinSandboxPrepScript(baseOpts)

    expect(script).toContain("/tmp/flue-env.sh.tmp")
    expect(script).toContain("mv /tmp/flue-env.sh.tmp /tmp/flue-env.sh")
    expect(script).toContain("export GH_TOKEN=")
    expect(script).not.toContain("grep -v '^export GH_TOKEN='")
  })

  it("produces syntactically valid bash", () => {
    expect(() => execFileSync("bash", ["-n", renderToFile(baseOpts)])).not.toThrow()
  })
})
