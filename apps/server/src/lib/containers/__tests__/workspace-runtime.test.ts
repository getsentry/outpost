import { DatabaseSync } from "node:sqlite"
import {
  createSandboxSessionEnv,
  instrument,
  type SandboxApi,
  type SessionEnv,
  useAgentFinish,
  useAgentStart,
  useModel,
} from "@flue/runtime"
import { agentStreamPath, createCloudflareAgentRuntime, createFlueContext } from "@flue/runtime/internal"
import { afterEach, describe, expect, it, vi } from "vitest"
import { acknowledgeWorkspaceLoss, workspaceStore } from "../workspace-checkpoint"
import { assertWorkspaceUsable, currentWorkspace, recoverableSandbox, workspaceInterceptor } from "../workspace-runtime"

const mocks = vi.hoisted(() => ({ context: vi.fn(), sandbox: vi.fn(), prep: vi.fn(async () => {}) }))
vi.mock("@cloudflare/sandbox", () => ({ getSandbox: mocks.sandbox }))
vi.mock("@flue/runtime/cloudflare", () => ({ getCloudflareContext: mocks.context }))
vi.mock("../do-prep", () => ({ ensureDoSandboxPrepped: mocks.prep }))
const databases: DatabaseSync[] = []
// Pin this integration seam to the patched Flue release. An upgrade must rerun
// these tests against the actual discovery/reconciliation implementation.
const flue = await import(
  new URL("./conversation-stream-store-CIKkNpqs.mjs", import.meta.resolve("@flue/runtime")).href
)
const flueSql = await import(
  new URL("./sql-agent-execution-store-DokZyrAM.mjs", import.meta.resolve("@flue/runtime")).href
)
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  vi.clearAllMocks()
  vi.useRealTimers()
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
  const storage = { sql, transactionSync: <T>(callback: () => T) => callback() }
  const prepared = createCloudflareAgentRuntime({
    agents: [],
    createContext: () => {
      throw new Error("Unused context")
    },
    runWithInstanceContext: (_instance, _name, callback) => callback(),
  }).prepare({ storage, className: "JaredAgent", agentName: "jared" })
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
  return { invoke, sandbox, sql, prepared }
}

describe("Flue workspace integration", () => {
  it("retries preparation's own probe before restoring a missing repository", async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.sandbox.exec
      .mockResolvedValueOnce({ success: false, exitCode: 44, stdout: "" })
      .mockRejectedValueOnce(new Error("Network connection lost"))
      .mockResolvedValueOnce({ success: false, exitCode: 44, stdout: "" })
    const result = f
      .invoke(async () => {
        await currentWorkspace().start(false)
        return "ready"
      })
      .catch((error) => error)
    await vi.runAllTimersAsync()
    expect(await result).toBe("ready")
    expect(mocks.prep).toHaveBeenCalledTimes(1)
    expect(workspaceStore(f.sql).read()?.blocked).toBeUndefined()
  })

  it("retains classified diagnostics when preparation's probe exhausts its retries", async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.sandbox.exec
      .mockResolvedValueOnce({ success: false, exitCode: 44, stdout: "" })
      .mockRejectedValue(new Error("Network connection lost"))
    const result = f.invoke(async () => currentWorkspace().start(false)).catch((error) => error)
    await vi.runAllTimersAsync()
    expect(await result).toMatchObject({
      type: "workspace_lost",
      meta: { workspaceProbe: { kind: "transport", attempts: 3 } },
    })
    expect(mocks.prep).not.toHaveBeenCalled()
    expect(workspaceStore(f.sql).read()?.inFlight).toBe(true)
  })

  it.each([
    "healthy",
    "blocked",
    "inFlight",
  ])("reconciles a persisted final answer through the %s completion guard without replay", async (state) => {
    const f = fixture()
    const submissionId = "sub-repo-1"
    const attemptId = "old-attempt"
    const starts = vi.fn()
    const finishes = vi.fn(() => currentWorkspace().assertUsable())
    const Agent = () => {
      useModel("test/model", { compaction: false })
      useAgentStart(starts)
      useAgentFinish(finishes)
      return "Test agent"
    }
    const writer = await flueSql.r.create({
      store: f.prepared.conversationStreamStore,
      path: agentStreamPath("jared", "repo-1"),
      identity: { agentName: "jared", instanceId: "repo-1" },
      producerId: "test",
    })
    const { conversationId } = await flue.l(writer, Agent)
    const input = {
      kind: "direct" as const,
      submissionId,
      agent: "jared",
      id: "repo-1",
      message: { kind: "user" as const, body: "Do the work" },
      acceptedAt: new Date().toISOString(),
    }
    const submissions = f.prepared.submissionStore
    await submissions.admitDirect(input)
    await submissions.markSubmissionCanonicalReady(submissionId)
    const submission = await submissions.claimSubmission({
      submissionId,
      attemptId,
      ownerId: "test",
      leaseExpiresAt: Date.now() + 60_000,
    })
    expect(submission).not.toBeNull()
    const userId = `entry_direct_${Buffer.from(submissionId).toString("base64url")}`
    const envelope = {
      v: 1,
      conversationId,
      harness: "default",
      session: "default",
      timestamp: new Date().toISOString(),
      submissionId,
      attemptId,
    }
    const usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    }
    await writer.append(
      [
        {
          ...envelope,
          id: "record_user",
          type: "user_message",
          messageId: userId,
          parentId: null,
          content: [{ type: "text", text: input.message.body }],
        },
        {
          ...envelope,
          id: "record_answer",
          type: "assistant_message_started",
          messageId: "entry_answer",
          parentId: userId,
          modelInfo: { api: "openai-completions", provider: "openai", model: "gpt-4o" },
        },
        {
          ...envelope,
          id: "record_done",
          type: "assistant_message_completed",
          messageId: "entry_answer",
          stopReason: "stop",
          usage,
        },
      ],
      { submission: { submissionId, attemptId } },
    )
    const testModel = {
      id: "model",
      name: "model",
      api: "openai-completions" as const,
      provider: "test",
      baseUrl: "https://invalid.example",
      reasoning: false,
      input: ["text" as const],
      contextWindow: 100000,
      maxTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }
    const createContext = () =>
      createFlueContext({
        id: "repo-1",
        agentName: "jared",
        submissionId,
        env: {},
        agentConfig: { resolveModel: () => testModel },
        conversationWriter: writer,
        attachmentStore: f.prepared.attachmentStore,
      })
    if (state !== "healthy")
      workspaceStore(f.sql).write({
        runId: submissionId,
        inFlight: state === "inFlight",
        recoveries: 0,
        ...(state === "blocked" ? { blocked: "uncertain mutation" } : {}),
      })
    const model = vi.spyOn(flue.y.prototype, "runModelTurnWithRecovery").mockImplementation(() => {
      throw new Error("Must not replay the model")
    })
    const dispose = instrument({ observe: () => {}, interceptor: workspaceInterceptor, dispose: () => {} })
    try {
      const replacement = await flue.m(
        submissions,
        submission,
        Agent,
        createContext,
        { ownerId: "replacement", leaseExpiresAt: Date.now() + 60_000 },
        writer,
      )
      expect(replacement?.attemptId).toBeTypeOf("string")
      expect(replacement.attemptId).not.toBe(attemptId)
      const process = flue.p({
        submissions,
        submission: replacement,
        resolveAgent: () => Agent,
        createContext,
        conversationWriter: writer,
      })
      if (state === "healthy") await process
      else await expect(process).rejects.toMatchObject({ type: "workspace_lost" })
      const settled = await submissions.getSubmission(submissionId)
      expect(settled?.status).toBe("settled")
      const receipt = await writer.getRecord(`record_direct-submission:${submissionId}:settled`)
      expect(receipt).toMatchObject(
        state === "healthy" ? { outcome: "completed" } : { outcome: "failed", error: { type: "workspace_lost" } },
      )
      expect(starts).not.toHaveBeenCalled()
      expect(model).not.toHaveBeenCalled()
      expect(f.sandbox.writeFile).not.toHaveBeenCalled()
      if (state === "healthy") expect(finishes).toHaveBeenCalledOnce()
    } finally {
      model.mockRestore()
      await dispose()
    }
  })

  it("discovers a reconciliation session outside the run scope without touching the sandbox", async () => {
    const f = fixture()
    const inner = createSandboxSessionEnv(f.sandbox as unknown as SandboxApi, "/workspace/repo")
    const session = await recoverableSandbox({ createSessionEnv: async () => inner }, f.sandbox).createSessionEnv({
      id: "one",
    })
    await expect(flue.w(session)).resolves.toMatchObject({ skills: {} })
    expect(f.sandbox.exec).not.toHaveBeenCalled()
    expect(f.sandbox.writeFile).not.toHaveBeenCalled()
    expect(() => session.exec("touch should-not-run")).toThrow(/blocked/)
  })

  it.each([
    "queued",
    "running",
    "terminalizing",
    "joining",
    "joined",
    "future-status",
  ])("rejects stale acknowledgement when a %s submission appears after the history read", (status) => {
    const f = fixture()
    const store = workspaceStore(f.sql)
    store.write({ runId: "original", blocked: "uncertain mutation", inFlight: true, recoveries: 0 })
    // The route has already observed the original settled receipt. A new
    // admission before its RPC must prevent the DO from clearing the guard.
    f.sql.exec(
      "INSERT INTO flue_agent_submissions (submission_id, session_key, kind, payload, status, accepted_at) VALUES (?, ?, ?, ?, ?, ?)",
      "new",
      "session",
      "direct",
      "{}",
      status,
      1,
    )
    expect(acknowledgeWorkspaceLoss(store, "original", f.sql)).toBe(false)
    expect(store.read()?.blocked).toBe("uncertain mutation")
  })

  it("fails acknowledgement closed on unknown runtime schema and clears only an inactive exact blocker", () => {
    const f = fixture()
    const store = workspaceStore(f.sql)
    store.write({ runId: "original", blocked: "uncertain mutation", inFlight: true, recoveries: 0 })
    expect(acknowledgeWorkspaceLoss(store, "different", f.sql)).toBe(false)
    expect(acknowledgeWorkspaceLoss(store, "original", f.sql)).toBe(true)
    expect(store.read()).toEqual({ runId: "original", inFlight: false, recoveries: 0 })
    store.write({ runId: "original", blocked: "uncertain mutation", inFlight: true, recoveries: 0 })
    f.sql.exec("DROP TABLE flue_agent_submissions")
    expect(acknowledgeWorkspaceLoss(store, "original", f.sql)).toBe(false)
    expect(store.read()?.blocked).toBe("uncertain mutation")
  })

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
