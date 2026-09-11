import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { getSandbox } from "@cloudflare/sandbox"
import { afterEach, describe, expect, it } from "vitest"
import { GITHUB_COMMAND_ENV, withGitHubCommandEnv } from "../command-environment"
import {
  buildThinSandboxPrepScript,
  ensureSandboxReady,
  type SandboxSetupOpts,
  THIN_SANDBOX_READY_CHECK,
} from "../dispatch"

const baseOpts: SandboxSetupOpts = {
  repo: "getsentry/cli",
  botLogin: "jared-agent[bot]",
  installationToken: "ghs_exampletoken1234567890",
  entityKey: "getsentry/cli#1365",
  openaiApiKey: "openai-test-key",
  anthropicApiKey: "anthropic-test-key",
  openrouterApiKey: "openrouter-test-key",
}

const fixtureDirs: string[] = []
afterEach(() => {
  for (const dir of fixtureDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function prepFixture() {
  const dir = mkdtempSync(join(tmpdir(), "thin-prep-auth-"))
  fixtureDirs.push(dir)
  for (const path of ["workspace", "tmp", "bin", "root/.agents/skills", "config"])
    mkdirSync(join(dir, path), { recursive: true })
  writeFileSync(join(dir, "root/.agents/skills/test.md"), "fixture skill")
  execFileSync("git", ["init", "--bare", join(dir, "seed.git")], { stdio: "ignore" })

  // Replace only the external auth service. Execute the generated bash, git,
  // lock, environment publication, and skills copy for real in a disposable tree.
  writeFileSync(
    join(dir, "bin/gh"),
    `#!/bin/bash
set -eu
if [ "$*" != "auth setup-git --hostname github.com" ]; then
  echo "Installation tokens must use environment authentication, not auth login" >&2
  exit 1
fi
if [ "\${TEST_SETUP_FAIL:-0}" = 1 ]; then
  echo "credential helper setup failed" >&2
  exit 1
fi
test -n "$GH_TOKEN"
printf '%s' "$GH_TOKEN" > "$TEST_AUTH_RECEIPT"
`,
    { mode: 0o700 },
  )

  const mapPaths = (value: string) =>
    value
      .replaceAll("/workspace", join(dir, "workspace"))
      .replaceAll("/tmp/flue-env", join(dir, "tmp/flue-env"))
      .replaceAll("/tmp/jared-github-env", join(dir, "tmp/jared-github-env"))
      .replaceAll("/root/", `${dir}/root/`)
      .replaceAll("/opt/flue/", `${dir}/opt/flue/`)
      .replaceAll("https://github.com/getsentry/cli.git", join(dir, "seed.git"))
  const commandEnv: Record<string, string | undefined> = {}
  const exec = (command: string, fail = false, env: Record<string, string | undefined> = {}) =>
    spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", mapPaths(command)], {
      encoding: "utf8",
      timeout: 5_000,
      env: {
        PATH: `${dir}/bin:${process.env.PATH}`,
        BASH_ENV: "/dev/null",
        TMPDIR: tmpdir(),
        GH_CONFIG_DIR: join(dir, "config"),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GITHUB_TOKEN: "inherited-stale-token",
        TEST_AUTH_RECEIPT: join(dir, "auth-receipt"),
        TEST_SETUP_FAIL: fail ? "1" : "0",
        ...commandEnv,
        ...Object.fromEntries(Object.entries(env).map(([key, value]) => [key, value && mapPaths(value)])),
      },
    })
  const run = (token: string, fail = false) => {
    writeFileSync(join(dir, "tmp/flue-env.pending"), `export GH_TOKEN='${token}'\n`, { mode: 0o600 })
    return exec(buildThinSandboxPrepScript(baseOpts), fail)
  }
  // Emulate only the remote API boundary. Every exec still runs in a fresh real
  // shell, so a token exported by prep cannot accidentally leak to later calls.
  const sandbox = {
    writeFile: async (path: string, contents: string) => writeFileSync(mapPaths(path), contents),
    setEnvVars: async (vars: Record<string, string | undefined>) => {
      Object.assign(commandEnv, vars)
    },
    exec: async (command: string, options?: { env?: Record<string, string | undefined> }) => {
      const result = exec(command, false, withGitHubCommandEnv(options)?.env)
      return { success: result.status === 0, stderr: result.stderr, stdout: result.stdout, exitCode: result.status }
    },
  } as unknown as ReturnType<typeof getSandbox>
  return { dir, run, sandbox }
}

function renderToFile(opts: SandboxSetupOpts): string {
  const dir = mkdtempSync(join(tmpdir(), "thin-prep-"))
  fixtureDirs.push(dir)
  const path = join(dir, "prep.sh")
  writeFileSync(path, buildThinSandboxPrepScript(opts))
  return path
}

describe("buildThinSandboxPrepScript", () => {
  it("refuses to delete surviving files in a workspace with a missing .git directory", () => {
    const f = prepFixture()
    const repo = join(f.dir, "workspace/repo")
    mkdirSync(repo)
    writeFileSync(join(repo, "uncommitted.txt"), "surviving work")
    expect(f.run("test-token").status).not.toBe(0)
    expect(readFileSync(join(repo, "uncommitted.txt"), "utf8")).toBe("surviving work")
  })
  it("refreshes auth without overwriting agent edits to injected workspace files", () => {
    const f = prepFixture()
    expect(f.run("test-token").status).toBe(0)
    const skill = join(f.dir, "workspace/repo/.agents/skills/test.md")
    writeFileSync(skill, "local agent edit")
    writeFileSync(join(f.dir, "root/.agents/skills/new.md"), "new skill")
    expect(f.run("fresh-test-token").status).toBe(0)
    expect(readFileSync(skill, "utf8")).toBe("local agent edit")
    expect(readFileSync(join(f.dir, "workspace/repo/.agents/skills/new.md"), "utf8")).toBe("new skill")
  })
  it("keeps command auth after DO memory is lost without exposing provider keys", async () => {
    const { dir, sandbox } = prepFixture()
    for (const token of ["initial-installation-token", "refreshed-installation-token"]) {
      await ensureSandboxReady(sandbox, { ...baseOpts, installationToken: token, thinSandbox: true })
      const command = await sandbox.exec('printf "%s" "$GH_TOKEN"')
      expect(command.success).toBe(true)
      expect(command.stdout).toBe(token)
      await sandbox.setEnvVars({ GH_TOKEN: undefined })
      expect((await sandbox.exec(THIN_SANDBOX_READY_CHECK)).success).toBe(true)
      expect((await sandbox.exec('printf "%s" "$GH_TOKEN"')).stdout).toBe(token)
      const bootstrap = readFileSync(join(dir, "tmp/jared-github-env.sh"), "utf8")
      expect(bootstrap).not.toContain(baseOpts.openaiApiKey!)
      expect(bootstrap).not.toContain(baseOpts.anthropicApiKey!)
      expect(bootstrap).not.toContain(baseOpts.openrouterApiKey!)
      expect(statSync(join(dir, "tmp/jared-github-env.sh")).mode & 0o777).toBe(0o600)
      expect((await sandbox.exec(`test -z "\${OPENAI_API_KEY:-}"`)).success).toBe(true)
      expect(
        (await sandbox.exec(`test -z "\${ANTHROPIC_API_KEY:-}" && test -z "\${OPENROUTER_API_KEY:-}"`)).success,
      ).toBe(true)
      expect((await sandbox.exec(`test -z "\${BASH_ENV:-}"`)).success).toBe(true)
    }
    expect((await sandbox.exec('printf "%s" "$GH_TOKEN"', { env: { GH_TOKEN: "explicit-token" } })).stdout).toBe(
      "explicit-token",
    )
    expect((await sandbox.exec("exit 44")).exitCode).toBe(44)
    expect(GITHUB_COMMAND_ENV).toBe("/tmp/jared-github-env.sh")
  })

  it("does not consider a legacy in-memory token ready without the command bootstrap", async () => {
    const { dir, sandbox } = prepFixture()
    await ensureSandboxReady(sandbox, { ...baseOpts, thinSandbox: true })
    await sandbox.setEnvVars({ GH_TOKEN: "legacy-token" })
    rmSync(join(dir, "tmp/jared-github-env.sh"))
    expect((await sandbox.exec(THIN_SANDBOX_READY_CHECK)).success).toBe(false)
  })

  it("does not reuse stale bootstrap credentials when fresh preparation has no token", async () => {
    const { sandbox } = prepFixture()
    await ensureSandboxReady(sandbox, { ...baseOpts, thinSandbox: true })
    await expect(
      ensureSandboxReady(sandbox, { ...baseOpts, installationToken: "", thinSandbox: true }),
    ).rejects.toThrow()
    expect((await sandbox.exec('test -z "$GH_TOKEN"')).success).toBe(true)
  })

  it("fails closed without deleting an existing directory at the credential path", () => {
    const { dir, run } = prepFixture()
    const target = join(dir, "tmp/jared-github-env.sh")
    mkdirSync(target)
    writeFileSync(join(target, "preserved"), "existing data")
    const result = run("test-token")
    expect(result.status).toBe(73)
    expect(result.stderr).toContain("GitHub command auth path is a directory")
    expect(readFileSync(join(target, "preserved"), "utf8")).toBe("existing data")
    expect(existsSync(join(dir, "workspace/.thin-sandbox-prep.lock"))).toBe(false)
  })

  it("configures headless auth with fresh tokens on cold and warm workspaces", () => {
    const { dir, run } = prepFixture()
    for (const token of ["first-installation-token", "refreshed-installation-token"]) {
      const result = run(token)
      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(join(dir, "auth-receipt"), "utf8")).toBe(token)
      expect(readFileSync(join(dir, "tmp/flue-env.sh"), "utf8")).toBe(`export GH_TOKEN='${token}'\n`)
      expect(statSync(join(dir, "tmp/flue-env.sh")).mode & 0o777).toBe(0o600)
      expect(existsSync(join(dir, "workspace/repo/.git"))).toBe(true)
      expect(readFileSync(join(dir, "workspace/repo/.agents/skills/test.md"), "utf8")).toBe("fixture skill")
      expect(existsSync(join(dir, "workspace/.thin-sandbox-prep.lock"))).toBe(false)
      expect(existsSync(join(dir, "tmp/flue-env.pending"))).toBe(false)
    }
  })

  it("fails on credential helper errors and releases the setup lock", () => {
    const { dir, run } = prepFixture()
    const result = run("rejected-token", true)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("credential helper setup failed")
    expect(existsSync(join(dir, "tmp/flue-env.sh"))).toBe(false)
    expect(existsSync(join(dir, "workspace/.thin-sandbox-prep.lock"))).toBe(false)
  })

  it("serializes clone, credentials, skills, and verification behind one lock", () => {
    const script = buildThinSandboxPrepScript(baseOpts)

    expect(script).toContain("LOCK=/workspace/.thin-sandbox-prep.lock")
    expect(script).toContain("trap cleanup EXIT")
    expect(script).toContain("git clone --depth 50")
    expect(script).toContain("gh auth setup-git --hostname github.com")
    expect(script).toContain("copy_workspace_file -R /root/.agents/skills")
    expect(script).toContain("test -d /workspace/repo/.git")
  })

  it("replaces the complete environment atomically with GitHub auth included", () => {
    const script = buildThinSandboxPrepScript(baseOpts)

    expect(script).toContain("/tmp/flue-env.sh.tmp")
    expect(script).toContain("mv /tmp/flue-env.sh.tmp /tmp/flue-env.sh")
    expect(script).toContain('source "$ENV_SOURCE"')
    expect(script).not.toContain("grep -v '^export GH_TOKEN='")
  })

  it("keeps credentials out of the sandbox exec command", () => {
    const script = buildThinSandboxPrepScript(baseOpts)

    expect(script).not.toContain(baseOpts.installationToken)
    expect(script).not.toContain(baseOpts.openaiApiKey!)
    expect(script).toContain('git -c http.extraHeader="AUTHORIZATION: basic $AUTH_HEADER" clone')
  })

  it("produces syntactically valid bash", () => {
    expect(() => execFileSync("bash", ["-n", renderToFile(baseOpts)])).not.toThrow()
  })
})
