import { DatabaseSync } from "node:sqlite"
import { createSandboxSessionEnv, type SandboxApi, type SessionEnv } from "@flue/runtime"
import { afterEach, describe, expect, it, vi } from "vitest"
import { assertWorkspaceUsable, currentWorkspace, recoverableSandbox, workspaceInterceptor } from "../workspace-runtime"

const mocks = vi.hoisted(() => ({ context: vi.fn(), sandbox: vi.fn() }))
vi.mock("@cloudflare/sandbox", () => ({ getSandbox: mocks.sandbox }))
vi.mock("@flue/runtime/cloudflare", () => ({ getCloudflareContext: mocks.context }))
const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  vi.clearAllMocks()
})

function fixture(id = "repo-1") {
  const db = new DatabaseSync(":memory:")
  databases.push(db)
  const sql = {
    exec: (query: string, ...args: unknown[]) => {
      const rows = db.prepare(query).all(...(args as []))
      return { toArray: () => rows }
    },
  }
  mocks.context.mockReturnValue({ env: { Sandbox: {} }, storage: { sql } })
  const sandbox = {
    acquireRunLease: vi.fn(async (_id: string) => {}),
    releaseRunLease: vi.fn(async (_id: string) => {}),
    mkdir: vi.fn(async () => ({})),
    writeFile: vi.fn(async () => ({})),
    exec: vi.fn(async () => ({
      success: true,
      stdout: `generation\n${"a".repeat(40)}\nmain\n${"b".repeat(64)}\nready\n`,
      exitCode: 0,
    })),
  }
  mocks.sandbox.mockReturnValue(sandbox)
  const ctx = { instanceId: id, agentName: "jared", submissionId: `sub-${id}` }
  const invoke = <T>(next: () => Promise<T>) =>
    workspaceInterceptor({ type: "agent", operationId: ctx.submissionId, operationKind: "prompt" }, ctx, next)
  return { invoke, sandbox, sql }
}

describe("Flue workspace integration", () => {
  it("never starts a file write after an abandoned mkdir completes", async () => {
    const f = fixture()
    let finishMkdir!: () => void
    let abandoned!: Promise<unknown>
    const files = {
      mkdir: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishMkdir = resolve
          }),
      ),
      writeFile: vi.fn(async () => ({})),
    }
    const inner = createSandboxSessionEnv(files as unknown as SandboxApi, "/workspace/repo")
    await expect(
      f.invoke(async () => {
        const session = await recoverableSandbox({ createSessionEnv: async () => inner }, files).createSessionEnv({
          id: "one",
        })
        abandoned = session.writeFile("file.txt", "contents").catch((error) => error)
        await vi.waitFor(() => expect(finishMkdir).toBeTypeOf("function"))
        throw new DOMException("Operator cancelled", "AbortError")
      }),
    ).rejects.toMatchObject({ type: "workspace_lost" })
    finishMkdir()
    expect(await abandoned).toMatchObject({ type: "workspace_lost" })
    expect(files.writeFile).not.toHaveBeenCalled()
    await expect(f.invoke(async () => "model-only completion")).rejects.toMatchObject({ type: "workspace_lost" })
  })

  it("does not let the native file adapter replay an uncertain provider write", async () => {
    const f = fixture()
    const writeFile = vi.fn(async () => {
      throw new Error("write committed but response was lost")
    })
    const files = { writeFile, mkdir: vi.fn(async () => ({})) }
    const inner = createSandboxSessionEnv(files as unknown as SandboxApi, "/workspace/repo")
    await expect(
      f.invoke(async () => {
        const session = await recoverableSandbox({ createSessionEnv: async () => inner }, files).createSessionEnv({
          id: "one",
        })
        await session.writeFile("nested/file.txt", "content")
      }),
    ).rejects.toMatchObject({ type: "workspace_lost" })
    expect(writeFile).toHaveBeenCalledTimes(1)
  })
  it("holds the lease through execution and releases it after success", async () => {
    const f = fixture()
    expect(
      await f.invoke(async () => {
        await currentWorkspace().start(false)
        return "done"
      }),
    ).toBe("done")
    expect(f.sandbox.acquireRunLease).toHaveBeenCalledWith(expect.stringMatching(/^sub-repo-1:/))
    expect(f.sandbox.releaseRunLease).toHaveBeenCalledWith(f.sandbox.acquireRunLease.mock.calls[0][0])
    expect(() => assertWorkspaceUsable()).not.toThrow()
  })
  it("fails settlement even when the model swallows a tool error and says it finished", async () => {
    const f = fixture()
    const exec = vi.fn(async () => {
      throw new Error("lost response after creating PR")
    })
    await expect(
      f.invoke(async () => {
        const factory = recoverableSandbox(
          {
            createSessionEnv: async () => ({ cwd: "/workspace/repo", exec }) as unknown as SessionEnv,
          },
          f.sandbox,
        )
        const session = await factory.createSessionEnv({ id: "session" })
        await session.exec("gh pr create").catch(() => {})
        expect(() => assertWorkspaceUsable()).toThrow(/blocked/)
        return "completed"
      }),
    ).rejects.toMatchObject({ type: "workspace_lost" })
    expect(exec).toHaveBeenCalledOnce()
    expect(f.sandbox.releaseRunLease).toHaveBeenCalledOnce()
  })
  it("preserves the command options and delegates without creating another lease", async () => {
    const f = fixture()
    const exec = vi.fn(async () => ({ code: 0, stdout: "ok", stderr: "" }))
    const factory = recoverableSandbox(
      {
        createSessionEnv: async () => ({ cwd: "/workspace/repo", exec }) as unknown as SessionEnv,
      },
      f.sandbox,
    )
    const options = { cwd: "/", env: { TEST: "value" }, timeoutMs: 1000, signal: new AbortController().signal }
    await f.invoke(async () =>
      workspaceInterceptor(
        { type: "task", taskId: "delegate" },
        { agentName: "jared", instanceId: "repo-1" },
        async () => {
          const session = await factory.createSessionEnv({ id: "child" })
          await session.exec("pwd", options)
        },
      ),
    )
    expect(exec).toHaveBeenCalledWith("pwd", options)
    expect(f.sandbox.acquireRunLease).toHaveBeenCalledOnce()
  })
  it("keeps the typed failure when the runtime wraps it as an operation failure", async () => {
    const f = fixture()
    await expect(
      f.invoke(async () => {
        await currentWorkspace()
          .run(async () => {
            throw new Error("transport failure")
          }, true)
          .catch(() => {})
        throw new Error("wrapped operation failure")
      }),
    ).rejects.toMatchObject({ type: "workspace_lost" })
    expect(f.sandbox.releaseRunLease).toHaveBeenCalledOnce()
  })
})
