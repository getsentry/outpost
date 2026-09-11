import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import {
  inspectWorkspace,
  restoreCheckpointCommand,
  WORKSPACE_CHECKPOINT_COMMAND,
  workspaceStore,
} from "../workspace-checkpoint"
import { WorkspaceRecovery } from "../workspace-recovery"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "jared-checkpoint-"))
  dirs.push(dir)
  const repo = join(dir, "workspace/repo")
  mkdirSync(repo, { recursive: true })
  const env = { ...process.env, GH_TOKEN: "test-only", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  git("init", "-b", "main")
  git("config", "user.name", "Test")
  git("config", "user.email", "test@example.invalid")
  writeFileSync(join(repo, "file.txt"), "original\n")
  git("add", ".")
  git("commit", "-m", "seed")
  git("switch", "-c", "fix/saved-branch")
  writeFileSync(join(repo, "file.txt"), "saved commit\n")
  git("commit", "-am", "saved")
  const remote = join(dir, "remote.git")
  git("clone", "--bare", repo, remote)
  git("remote", "add", "origin", remote)
  const seed = (generation: string) => {
    mkdirSync(join(repo, ".agents/skills"), { recursive: true })
    writeFileSync(join(repo, ".agents/skills/test.md"), "test skill")
    writeFileSync(join(repo, ".git/jared-workspace-generation"), `${generation}\n`)
    writeFileSync(join(dir, "flue-env.sh"), "export GH_TOKEN='test-only'\n")
    writeFileSync(join(dir, "jared-github-env.sh"), "export GH_TOKEN='test-only'\nunset BASH_ENV\n")
  }
  seed("generation-1")
  const map = (script: string) =>
    script
      .replaceAll("/workspace", join(dir, "workspace"))
      .replaceAll("/tmp/flue-env.sh", join(dir, "flue-env.sh"))
      .replaceAll("/tmp/jared-github-env.sh", join(dir, "jared-github-env.sh"))
  const sandbox = {
    exec: async (command: string, options: { cwd?: string } = {}) => {
      const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", map(command)], {
        cwd: options.cwd ?? "/",
        env,
        encoding: "utf8",
        timeout: 5000,
      })
      if (result.error) throw result.error
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status!, success: result.status === 0 }
    },
  }
  return {
    dir,
    repo,
    git,
    seed,
    sandbox,
    map,
    recreate: () => {
      rmSync(repo, { recursive: true, force: true })
      execFileSync("git", ["clone", "--branch", "main", remote, repo], { env, stdio: "ignore" })
      seed("generation-2")
    },
  }
}

describe("real Git workspace checkpoints", () => {
  it("preserves dangling untracked symlinks without dereferencing them", async () => {
    const f = fixture()
    symlinkSync("missing-target", join(f.repo, "link"))
    const inspect = () => inspectWorkspace(f.sandbox as Parameters<typeof inspectWorkspace>[0])
    const before = await inspect()
    expect(before?.ready).toBe(true)
    writeFileSync(join(f.repo, "missing-target"), "target contents")
    f.git("add", "missing-target")
    expect((await inspect())?.ready).toBe(true)
  })

  it("detects untracked symlink target and executable-bit changes", async () => {
    const f = fixture()
    writeFileSync(join(f.repo, "a.txt"), "same contents")
    writeFileSync(join(f.repo, "b.txt"), "same contents")
    const link = join(f.repo, "link")
    symlinkSync("a.txt", link)
    const inspect = () => inspectWorkspace(f.sandbox as Parameters<typeof inspectWorkspace>[0])
    const before = await inspect()
    unlinkSync(link)
    symlinkSync("b.txt", link)
    const afterLink = await inspect()
    expect(afterLink?.fingerprint).not.toBe(before?.fingerprint)
    chmodSync(join(f.repo, "a.txt"), 0o755)
    expect((await inspect())?.fingerprint).not.toBe(afterLink?.fingerprint)
  })

  it("detects staged changes even when working files are restored to HEAD", async () => {
    const f = fixture()
    const inspect = () => inspectWorkspace(f.sandbox as Parameters<typeof inspectWorkspace>[0])
    const clean = await inspect()
    writeFileSync(join(f.repo, "file.txt"), "staged but not in working tree")
    f.git("add", "file.txt")
    writeFileSync(join(f.repo, "file.txt"), "saved commit\n")
    expect((await inspect())?.fingerprint).not.toBe(clean?.fingerprint)
  })
  it("distinguishes a missing cwd from a missing shell using the root probe", async () => {
    const f = fixture()
    rmSync(f.repo, { recursive: true })
    await expect(f.sandbox.exec("pwd", { cwd: f.repo })).rejects.toThrow(/ENOENT/)
    expect(await inspectWorkspace(f.sandbox as Parameters<typeof inspectWorkspace>[0])).toBeNull()
  })
  it("restores the saved branch and exact commit before a safe read", async () => {
    const f = fixture()
    const sqlDb = new DatabaseSync(":memory:")
    const sql = {
      exec: (query: string, ...args: unknown[]) => {
        const rows = sqlDb.prepare(query).all(...(args as []))
        return { toArray: () => rows }
      },
    }
    const store = workspaceStore(sql)
    const inspect = () => inspectWorkspace(f.sandbox as Parameters<typeof inspectWorkspace>[0])
    const guard = new WorkspaceRecovery({
      runId: "one",
      store,
      inspect,
      prepare: async (checkpoint) => {
        f.recreate()
        if (checkpoint) {
          const result = await f.sandbox.exec(restoreCheckpointCommand(checkpoint))
          expect(result.success, result.stderr).toBe(true)
        }
      },
    })
    await guard.start(false)
    const saved = store.read()?.checkpoint
    rmSync(f.repo, { recursive: true })
    await guard.run(async () => "read", false)
    expect(store.read()?.checkpoint).toMatchObject({
      head: saved?.head,
      branch: "fix/saved-branch",
      fingerprint: saved?.fingerprint,
    })
    expect(f.git("symbolic-ref", "--short", "HEAD")).toBe("fix/saved-branch")
    sqlDb.close()
  })
  it("fingerprints tracked and untracked edits without persisting their contents", async () => {
    const f = fixture()
    const inspect = () => inspectWorkspace(f.sandbox as Parameters<typeof inspectWorkspace>[0])
    const before = await inspect()
    writeFileSync(join(f.repo, "file.txt"), "private edited content")
    const tracked = await inspect()
    writeFileSync(join(f.repo, "untracked.txt"), "private untracked content")
    const untracked = await inspect()
    expect(tracked?.fingerprint).not.toBe(before?.fingerprint)
    expect(untracked?.fingerprint).not.toBe(tracked?.fingerprint)
    expect(JSON.stringify(untracked)).not.toContain("private")
  })
  it("does not treat a damaged repo containing local files as an empty sandbox", async () => {
    const f = fixture()
    rmSync(join(f.repo, ".git"), { recursive: true })
    await expect(inspectWorkspace(f.sandbox as Parameters<typeof inspectWorkspace>[0])).rejects.toMatchObject({
      kind: "command_failed",
      exitCode: 45,
    })
  })
  it("reports malformed checkpoint output without exposing stdout or stderr", async () => {
    const sandbox = {
      exec: async () => ({
        stdout: "private checkpoint output",
        stderr: "private stderr",
        exitCode: 0,
        success: true,
        command: "probe",
        duration: 1,
        timestamp: new Date().toISOString(),
      }),
    }
    await expect(inspectWorkspace(sandbox)).rejects.toMatchObject({
      kind: "invalid_checkpoint",
      message: "Workspace probe failed: invalid_checkpoint",
    })
  })
  it("uses valid bash for probing and restoring detached checkpoints", () => {
    const f = fixture()
    execFileSync("bash", ["-n", "-c", WORKSPACE_CHECKPOINT_COMMAND])
    execFileSync("bash", [
      "-n",
      "-c",
      restoreCheckpointCommand({
        generation: "one",
        head: f.git("rev-parse", "HEAD"),
        branch: "",
        fingerprint: "a".repeat(64),
        ready: true,
      }),
    ])
  })
})
