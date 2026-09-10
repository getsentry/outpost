import { describe, expect, it, vi } from "vitest"
import { WorkspaceRecovery, type WorkspaceSnapshot, type WorkspaceState } from "../workspace-recovery"

const clean: WorkspaceSnapshot = {
  generation: "original",
  head: "a".repeat(40),
  branch: "fix/issue",
  fingerprint: "b".repeat(64),
  ready: true,
}

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
      const result = expect(f.guard.start(false)).rejects.toMatchObject({ type: "workspace_lost" })
      await vi.advanceTimersByTimeAsync(30_001)
      await result
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
    expect(f.prepare).toHaveBeenCalledWith(clean, expect.any(AbortSignal))
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
