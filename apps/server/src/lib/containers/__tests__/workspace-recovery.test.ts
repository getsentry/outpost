import { afterEach, describe, expect, it, vi } from "vitest"
import { WorkspaceRecovery, type WorkspaceSnapshot, type WorkspaceState } from "../workspace-recovery"

const clean: WorkspaceSnapshot = {
  generation: "original",
  head: "a".repeat(40),
  branch: "fix/issue",
  fingerprint: "b".repeat(64),
  ready: true,
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function fixture(saved?: WorkspaceState) {
  let state = saved
  let snapshot: WorkspaceSnapshot | null = { ...clean }
  const inspect = vi.fn(async () => snapshot && { ...snapshot })
  const prepare = vi.fn(async (_checkpoint: WorkspaceSnapshot | undefined, _signal: AbortSignal) => {
    snapshot = { ...clean, generation: "replacement" }
  })
  const store = {
    read: () => state,
    write: (value: WorkspaceState) => {
      state = structuredClone(value)
    },
  }
  const guard = new WorkspaceRecovery({ inspect, prepare, store, runId: "run-1" })
  return {
    guard,
    inspect,
    prepare,
    store,
    lose: () => {
      snapshot = null
    },
    set: (value: WorkspaceSnapshot) => {
      snapshot = value
    },
  }
}

describe("workspace recovery", () => {
  it("retries a transient preflight probe before starting a command exactly once", async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.inspect.mockRejectedValueOnce(new Error("Network connection lost"))
    const command = vi.fn(async () => "done")
    const result = expect(f.guard.run(command, true)).resolves.toBe("done")
    await vi.runAllTimersAsync()
    await result
    expect(command).toHaveBeenCalledTimes(1)
    expect(f.store.read()?.blocked).toBeUndefined()
    expect(f.prepare).not.toHaveBeenCalled()
  })

  it("recognizes structured SDK transport failures without depending on their message", async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.inspect.mockRejectedValueOnce(Object.assign(new Error("peer closed"), { code: "RPC_TRANSPORT_ERROR" }))
    const result = expect(f.guard.start(false)).resolves.toBeUndefined()
    await vi.runAllTimersAsync()
    await result
    expect(f.store.read()?.checkpoint).toEqual(clean)
  })

  it("ignores a timed-out probe's late result after a healthy retry", async () => {
    vi.useFakeTimers()
    const f = fixture()
    let finish!: (value: WorkspaceSnapshot | null) => void
    f.inspect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const result = expect(f.guard.start(false)).resolves.toBeUndefined()
    await vi.advanceTimersByTimeAsync(30_401)
    await result
    finish(null)
    await Promise.resolve()
    expect(f.store.read()?.checkpoint).toEqual(clean)
    expect(f.store.read()?.blocked).toBeUndefined()
    expect(f.prepare).not.toHaveBeenCalled()
  })

  it("bounds transient retries and preserves safe diagnostics across brain restarts", async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const f = fixture()
    f.inspect.mockRejectedValue(new Error("Network connection lost with private-token-and-command"))
    const result = expect(f.guard.start(false)).rejects.toMatchObject({
      type: "workspace_lost",
      meta: { workspaceRunId: "run-1", workspaceProbe: { kind: "transport", attempts: 3 } },
    })
    await vi.runAllTimersAsync()
    await result
    expect(f.inspect).toHaveBeenCalledTimes(3)
    expect(f.prepare).not.toHaveBeenCalled()
    expect(JSON.stringify(f.store.read())).not.toContain("private-token-and-command")
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private-token-and-command")
    expect(warn).toHaveBeenCalledWith(
      "jared: workspace probe failed",
      expect.objectContaining({ kind: "transport", attempts: 3 }),
    )
    const resumed = new WorkspaceRecovery({ inspect: f.inspect, prepare: f.prepare, store: f.store, runId: "run-2" })
    expect(() => resumed.finish()).toThrow(
      expect.objectContaining({
        meta: { workspaceRunId: "run-1", workspaceProbe: { kind: "transport", attempts: 3 } },
      }),
    )
  })

  it("does not retry an unknown probe failure or expose its raw message", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const f = fixture()
    f.inspect.mockRejectedValue(new Error("sensitive repository data"))
    await expect(f.guard.start(false)).rejects.toMatchObject({
      type: "workspace_lost",
      meta: { workspaceProbe: { kind: "unknown", attempts: 1 } },
    })
    expect(f.inspect).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(f.store.read())).not.toContain("sensitive repository data")
  })

  it("stops retrying when cancellation arrives during backoff", async () => {
    vi.useFakeTimers()
    const f = fixture()
    const controller = new AbortController()
    f.inspect.mockRejectedValueOnce(new Error("Network connection lost"))
    const result = expect(f.guard.start(false, controller.signal)).rejects.toMatchObject({ name: "AbortError" })
    await vi.advanceTimersByTimeAsync(1)
    controller.abort()
    await vi.runAllTimersAsync()
    await result
    expect(f.inspect).toHaveBeenCalledTimes(1)
    expect(f.store.read()?.blocked).toBeUndefined()
  })

  it("does not let a superseded attempt start another probe", async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.inspect.mockRejectedValueOnce(new Error("Network connection lost"))
    const old = expect(f.guard.start(false)).rejects.toMatchObject({ type: "workspace_lost" })
    await vi.advanceTimersByTimeAsync(1)
    const next = new WorkspaceRecovery({ inspect: f.inspect, prepare: f.prepare, store: f.store, runId: "run-2" })
    await next.start(false)
    const saved = structuredClone(f.store.read())
    await vi.runAllTimersAsync()
    await old
    expect(f.inspect).toHaveBeenCalledTimes(2)
    expect(f.store.read()).toEqual(saved)
  })

  it("retries a post-write health probe without replaying the write", async () => {
    vi.useFakeTimers()
    const f = fixture()
    const write = vi.fn(async () => {
      f.inspect.mockRejectedValueOnce(new Error("Network connection lost"))
      return "written"
    })
    const result = expect(f.guard.run(write, true)).resolves.toBe("written")
    await vi.runAllTimersAsync()
    await result
    expect(write).toHaveBeenCalledTimes(1)
    expect(f.store.read()?.inFlight).toBe(false)
  })

  it("cancels post-command probe retries and retains the uncertain mutation", async () => {
    vi.useFakeTimers()
    const f = fixture()
    const controller = new AbortController()
    const write = vi.fn(async () => {
      f.inspect.mockRejectedValue(new Error("Network connection lost"))
    })
    const result = f.guard.run(write, true, controller.signal).catch((error) => error)
    await vi.advanceTimersByTimeAsync(1)
    controller.abort()
    await vi.runAllTimersAsync()
    expect(await result).toMatchObject({ name: "AbortError" })
    expect(write).toHaveBeenCalledTimes(1)
    expect(f.inspect).toHaveBeenCalledTimes(2)
    expect(f.store.read()?.inFlight).toBe(true)
    expect(() => f.guard.finish()).toThrow(/blocked/)
  })

  it("blocks inherited uncertainty even if a resumed run only renders or finishes", () => {
    const f = fixture({ checkpoint: clean, inFlight: true, recoveries: 0, runId: "old-run" })
    expect(() => f.guard.assertUsable()).toThrow(/blocked/)
    expect(f.store.read()?.blocked).toBeTruthy()
  })

  it("does not start preparation after a health probe is cancelled", async () => {
    const f = fixture()
    let finish!: () => void
    f.inspect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(null)
        }),
    )
    const controller = new AbortController()
    const result = expect(f.guard.start(false, controller.signal)).rejects.toMatchObject({ name: "AbortError" })
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"))
    controller.abort()
    finish()
    await result
    expect(f.prepare).not.toHaveBeenCalled()
    expect(f.store.read()?.blocked).toBeUndefined()
  })

  it("cancels preparation and records uncertainty once setup has started", async () => {
    const f = fixture()
    f.lose()
    let preparationSignal: AbortSignal | undefined
    f.prepare.mockImplementation((_checkpoint, signal) => {
      preparationSignal = signal
      return new Promise(() => {})
    })
    const controller = new AbortController()
    const result = expect(f.guard.start(false, controller.signal)).rejects.toMatchObject({ type: "workspace_lost" })
    await vi.waitFor(() => expect(preparationSignal).toBeDefined())
    controller.abort()
    await result
    expect(preparationSignal?.aborted).toBe(true)
    expect(f.store.read()?.blocked).toBeTruthy()
  })

  it("bounds a health probe even when the SDK promise never settles", async () => {
    vi.useFakeTimers()
    try {
      const f = fixture()
      f.inspect.mockImplementation(() => new Promise(() => {}))
      const result = expect(f.guard.start(false)).rejects.toMatchObject({
        type: "workspace_lost",
        meta: { workspaceProbe: { kind: "timeout", attempts: 3 } },
      })
      await vi.advanceTimersByTimeAsync(91_201)
      await result
      expect(f.inspect).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it("bounds hung preparation and retains its uncertain-operation marker", async () => {
    vi.useFakeTimers()
    try {
      const f = fixture()
      f.lose()
      f.prepare.mockImplementation(() => new Promise(() => {}))
      const result = expect(f.guard.start(false)).rejects.toMatchObject({ type: "workspace_lost" })
      await vi.advanceTimersByTimeAsync(180_001)
      await result
      expect(f.store.read()?.inFlight).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
  it("preserves a durable blocker when a different delivery arrives", async () => {
    const f = fixture({
      checkpoint: clean,
      inFlight: false,
      recoveries: 2,
      runId: "old-run",
      blocked: "Local changes could not be restored",
    })
    await expect(f.guard.start(false)).rejects.toMatchObject({ type: "workspace_lost" })
    expect(f.inspect).not.toHaveBeenCalled()
    expect(f.store.read()?.runId).toBe("old-run")
  })

  it("fences a late abandoned operation from overwriting a newer blocker", async () => {
    const f = fixture()
    await f.guard.start(false)
    let finish!: () => void
    const abandoned = f.guard.run(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
      true,
    )
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"))
    const newer = new WorkspaceRecovery({ inspect: f.inspect, prepare: f.prepare, store: f.store, runId: "new-run" })
    await expect(newer.start(false)).rejects.toMatchObject({ type: "workspace_lost" })
    const blocked = structuredClone(f.store.read())
    finish()
    await expect(abandoned).rejects.toMatchObject({ type: "workspace_lost" })
    expect(f.store.read()).toEqual(blocked)
    expect(f.store.read()?.inFlight).toBe(true)
  })
  it("does not prepare or inspect a workspace when an earlier mutation is uncertain", async () => {
    const f = fixture({ checkpoint: clean, inFlight: true, recoveries: 0, runId: "old-run" })
    f.lose()
    await expect(f.guard.run(async () => "no", false)).rejects.toMatchObject({ type: "workspace_lost" })
    expect(f.inspect).not.toHaveBeenCalled()
    expect(f.prepare).not.toHaveBeenCalled()
  })

  it("does not poison the workspace for an operation cancelled before it starts", async () => {
    const f = fixture()
    const controller = new AbortController()
    controller.abort()
    const command = vi.fn()
    await expect(f.guard.run(command, true, controller.signal)).rejects.toMatchObject({ name: "AbortError" })
    expect(command).not.toHaveBeenCalled()
    expect(f.store.read()?.inFlight).not.toBe(true)
    expect(() => f.guard.assertUsable()).not.toThrow()
  })

  it("records a blocker if the safe read retry also loses its workspace", async () => {
    const f = fixture()
    await f.guard.start(false)
    const read = vi.fn(async () => {
      f.lose()
      throw new Error("gone")
    })
    await expect(f.guard.run(read, false)).rejects.toMatchObject({ type: "workspace_lost" })
    expect(read).toHaveBeenCalledTimes(2)
    expect(() => f.guard.assertUsable()).toThrow()
  })
  it("restores the exact checkpoint before executing a command in a lost cwd", async () => {
    const f = fixture()
    await f.guard.start(false)
    f.lose()
    const command = vi.fn(async () => "ok")
    expect(await f.guard.run(command, true)).toBe("ok")
    expect(f.prepare).toHaveBeenCalledWith(clean, expect.any(AbortSignal), expect.any(Function))
    expect(command).toHaveBeenCalledTimes(1)
  })

  it("never replays a possibly-executed mutation after workspace loss", async () => {
    const f = fixture()
    await f.guard.start(false)
    const push = vi.fn(async () => {
      f.lose()
      throw new Error("connection lost after push")
    })
    await expect(f.guard.run(push, true)).rejects.toMatchObject({ type: "workspace_lost" })
    expect(push).toHaveBeenCalledTimes(1)
    expect(f.prepare).not.toHaveBeenCalled()
    expect(() => f.guard.assertUsable()).toThrow(/blocked/i)
  })

  it("retries a safe read once after restoring a lost workspace", async () => {
    const f = fixture()
    await f.guard.start(false)
    const read = vi
      .fn()
      .mockImplementationOnce(async () => {
        f.lose()
        throw new Error("missing file")
      })
      .mockResolvedValue("contents")
    expect(await f.guard.run(read, false)).toBe("contents")
    expect(read).toHaveBeenCalledTimes(2)
  })

  it("blocks instead of continuing when local changes cannot be restored", async () => {
    const f = fixture()
    await f.guard.start(false)
    f.set({ ...clean, fingerprint: "c".repeat(64) })
    await f.guard.run(async () => undefined, true)
    f.lose()
    const command = vi.fn()
    await expect(f.guard.run(command, true)).rejects.toMatchObject({ type: "workspace_lost" })
    expect(command).not.toHaveBeenCalled()
  })

  it("preserves the checkpoint and uncertain operation across a brain restart", async () => {
    const f = fixture({ checkpoint: clean, inFlight: true, recoveries: 0, runId: "old-run" })
    await expect(f.guard.start(false)).rejects.toMatchObject({ type: "workspace_lost" })
    expect(f.prepare).not.toHaveBeenCalled()
  })

  it("bounds recovery across repeated workspace losses and stops later tools", async () => {
    const f = fixture()
    await f.guard.start(false)
    for (let n = 0; n < 2; n++) {
      f.lose()
      await f.guard.run(async () => "ok", false)
    }
    f.lose()
    await expect(f.guard.run(async () => "no", false)).rejects.toMatchObject({ type: "workspace_lost" })
    await expect(f.guard.run(async () => "no", false)).rejects.toMatchObject({ type: "workspace_lost" })
    expect(f.prepare).toHaveBeenCalledTimes(2)
  })

  it("does not turn a normal missing-file error into workspace recovery", async () => {
    const f = fixture()
    await f.guard.start(false)
    await expect(
      f.guard.run(async () => {
        throw new Error("file not found")
      }, false),
    ).rejects.toThrow("file not found")
    expect(f.prepare).not.toHaveBeenCalled()
    expect(() => f.guard.assertUsable()).not.toThrow()
  })

  it("serializes shared subagent operations so checkpoints cannot race writes", async () => {
    const f = fixture()
    await f.guard.start(false)
    let finish!: () => void
    const first = f.guard.run(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
      true,
    )
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"))
    const secondOperation = vi.fn(async () => "done")
    const second = f.guard.run(secondOperation, false)
    expect(secondOperation).not.toHaveBeenCalled()
    finish()
    await first
    await second
    expect(secondOperation).toHaveBeenCalledOnce()
  })
})
