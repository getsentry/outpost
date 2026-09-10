import type { getSandbox } from "@cloudflare/sandbox"
import { THIN_SANDBOX_READY_CHECK } from "./dispatch"
import { type DoPrepEnv, ensureDoSandboxPrepped } from "./do-prep"
import type { WorkspaceSnapshot, WorkspaceState, WorkspaceStore } from "./workspace-recovery"

const MARKER = "/workspace/repo/.git/jared-workspace-generation"
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

/** Probe from /, not the possibly-missing cwd that makes spawn report ENOENT. */
export const WORKSPACE_CHECKPOINT_COMMAND = [
  "set -euo pipefail",
  "if ! test -e /workspace/repo; then exit 44; fi",
  "if ! test -d /workspace/repo/.git; then exit 45; fi",
  "cd /workspace/repo",
  `if test -f ${MARKER}; then cat ${MARKER}; else printf 'untracked\\n'; fi`,
  "git rev-parse HEAD",
  "git symbolic-ref --quiet --short HEAD || printf '\\n'",
  // Store hashes only, never file contents or credentials. Include all tracked
  // changes and non-ignored untracked files, including the injected agent files.
  "{ git ls-files --stage -z; git diff --no-ext-diff --no-textconv --binary HEAD; git ls-files --others --exclude-standard -z; git ls-files --others --exclude-standard -z | xargs -0 -r sha256sum --; } | sha256sum | cut -d ' ' -f 1",
  `if ${THIN_SANDBOX_READY_CHECK}; then printf 'ready\\n'; else printf 'unready\\n'; fi`,
].join("\n")

export async function inspectWorkspace(
  sandbox: Pick<ReturnType<typeof getSandbox>, "exec">,
): Promise<WorkspaceSnapshot | null> {
  const result = await sandbox.exec(WORKSPACE_CHECKPOINT_COMMAND, { cwd: "/", timeout: 30_000 })
  if (result.exitCode === 44) return null
  if (!result.success) throw new Error("Workspace checkpoint probe failed")
  const [generation, head, branch, fingerprint, readiness] = result.stdout.trimEnd().split("\n")
  if (
    !generation ||
    !/^[a-f0-9]{40,64}$/.test(head ?? "") ||
    !/^[a-f0-9]{64}$/.test(fingerprint ?? "") ||
    !["ready", "unready"].includes(readiness ?? "")
  ) {
    throw new Error("Invalid workspace checkpoint")
  }
  return { generation, head, branch, fingerprint, ready: readiness === "ready" }
}

export function restoreCheckpointCommand(checkpoint: WorkspaceSnapshot): string {
  if (!/^[a-f0-9]{40,64}$/.test(checkpoint.head)) throw new Error("Invalid checkpoint commit")
  return [
    "set -eu",
    "cd /workspace/repo",
    `git fetch --depth=50 origin ${quote(checkpoint.head)}`,
    checkpoint.branch
      ? `git check-ref-format ${quote(`refs/heads/${checkpoint.branch}`)} && git checkout -B ${quote(checkpoint.branch)} ${quote(checkpoint.head)} --`
      : `git checkout --detach ${quote(checkpoint.head)} --`,
  ].join("\n")
}

export async function prepareWorkspace(
  env: DoPrepEnv,
  id: string,
  sandbox: ReturnType<typeof getSandbox>,
  checkpoint?: WorkspaceSnapshot,
  signal?: AbortSignal,
  assertOwner?: () => void,
) {
  const source = sandbox
  const check = () => {
    signal?.throwIfAborted()
    assertOwner?.()
  }
  const checked = async <T>(call: () => Promise<T>) => {
    check()
    const result = await call()
    check()
    return result
  }
  // Fence every provider call, including calls made inside prep's retry loop.
  // A timed-out RPC may finish late, but must not start another setup step.
  sandbox = {
    exec: (...args: Parameters<typeof source.exec>) => checked(() => source.exec(...args)),
    writeFile: (...args: Parameters<typeof source.writeFile>) => checked(() => source.writeFile(...args)),
    setEnvVars: (...args: Parameters<typeof source.setEnvVars>) => checked(() => source.setEnvVars(...args)),
  } as ReturnType<typeof getSandbox>
  const before = await inspectWorkspace(sandbox)
  await ensureDoSandboxPrepped(env, id, true, sandbox)
  // Only a missing repo may be reconstructed. A repo populated by another
  // caller is verified by the guard, never reset over somebody else's work.
  if (!before && checkpoint) {
    const result = await sandbox.exec(restoreCheckpointCommand(checkpoint), { cwd: "/", timeout: 120_000 })
    if (!result.success) throw new Error("Checkpoint commit is not recoverable from origin")
    // Restore versioned skill overlays after switching to the saved commit.
    await ensureDoSandboxPrepped(env, id, true, sandbox)
  }
  if (!before || before.generation === "untracked") {
    await sandbox.writeFile(MARKER, `${crypto.randomUUID()}\n`)
  }
}

type Sql = { exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] } }

/** App-owned state in the brain DO, not in the disposable sandbox or D1. */
export function workspaceStore(sql: Sql): WorkspaceStore {
  return {
    read() {
      if (
        !sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'jared_workspace_guard'").toArray()
          .length
      )
        return undefined
      const row = sql.exec("SELECT state FROM jared_workspace_guard WHERE id = 1").toArray()[0]
      return row ? (JSON.parse(String(row.state)) as WorkspaceState) : undefined
    },
    write(state) {
      sql.exec(
        "CREATE TABLE IF NOT EXISTS jared_workspace_guard (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL)",
      )
      sql.exec(
        "INSERT INTO jared_workspace_guard (id, state) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET state = excluded.state",
        JSON.stringify(state),
      )
    },
  }
}

/** Explicit operator acknowledgement only; never called by automatic retries. */
export function acknowledgeWorkspaceLoss(store: WorkspaceStore, runId: string): boolean {
  const state = store.read()
  if (!state?.blocked || state.runId !== runId) return false
  store.write({ runId, inFlight: false, recoveries: 0 })
  return true
}
