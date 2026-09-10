import { describe, expect, it, vi } from "vitest"
import { RunLeaseManager } from "../run-lease"

function fixture() {
  const entries = new Map<string, number>()
  const storage = {
    get: async (key: string) => entries.get(key),
    put: async (key: string, value: number) => {
      entries.set(key, value)
    },
    delete: async (key: string) => entries.delete(key),
    list: async ({ prefix }: { prefix: string }) => new Map([...entries].filter(([key]) => key.startsWith(prefix))),
  }
  const setKeepAlive = vi.fn(async (_value: boolean) => {})
  const schedule = vi.fn(async (_delay: number, _payload: { id: string; expiresAt: number }) => {})
  let now = 0
  const deps = { storage, setKeepAlive, schedule, now: () => now }
  return {
    deps,
    entries,
    schedule,
    setKeepAlive,
    advance: (value: number) => {
      now += value
    },
    manager: new RunLeaseManager(deps),
  }
}

describe("bounded sandbox run leases", () => {
  it("still disables keepalive if scheduling a successor fails", async () => {
    const f = fixture()
    await f.manager.acquire("one")
    const [seconds, payload] = f.schedule.mock.calls[0]
    f.advance(seconds * 1000)
    f.schedule.mockRejectedValueOnce(new Error("schedule unavailable"))
    await f.manager.expire(payload)
    expect(f.setKeepAlive).toHaveBeenLastCalledWith(false)
    expect(f.entries.has("jared-run-cleanup:one")).toBe(false)
  })

  it("rearms the watchdog if reading its cleanup receipt fails", async () => {
    const f = fixture()
    await f.manager.acquire("one")
    const [seconds, payload] = f.schedule.mock.calls[0]
    f.advance(seconds * 1000)
    vi.spyOn(f.deps.storage, "get").mockRejectedValueOnce(new Error("read unavailable"))
    await expect(f.manager.expire(payload)).rejects.toThrow("read unavailable")
    expect(f.schedule).toHaveBeenCalledTimes(2)
    await new RunLeaseManager(f.deps).expire(payload)
    expect(f.setKeepAlive).toHaveBeenLastCalledWith(false)
  })

  it("keeps a successor watchdog if disabling keepalive fails during expiry", async () => {
    const f = fixture()
    await f.manager.acquire("one")
    const [seconds, payload] = f.schedule.mock.calls[0]
    f.advance(seconds * 1000)
    f.setKeepAlive.mockRejectedValueOnce(new Error("transient storage failure"))
    await expect(f.manager.expire(payload)).rejects.toThrow("transient storage failure")
    expect(f.schedule).toHaveBeenCalledTimes(2)
    await new RunLeaseManager(f.deps).expire(f.schedule.mock.calls[1][1])
    expect(f.setKeepAlive).toHaveBeenLastCalledWith(false)
    const count = f.schedule.mock.calls.length
    await f.manager.expire(payload)
    expect(f.schedule).toHaveBeenCalledTimes(count)
  })
  it("schedules cleanup before enabling keepalive and releases on completion", async () => {
    const f = fixture()
    await f.manager.acquire("one")
    expect(f.schedule).toHaveBeenCalledOnce()
    expect(f.schedule.mock.invocationCallOrder[0]).toBeLessThan(f.setKeepAlive.mock.invocationCallOrder[0])
    expect(f.setKeepAlive).toHaveBeenLastCalledWith(true)
    await f.manager.release("one")
    expect(f.setKeepAlive).toHaveBeenLastCalledWith(false)
  })
  it("does not disable a different active run when one completes", async () => {
    const f = fixture()
    await Promise.all([f.manager.acquire("one"), f.manager.acquire("two")])
    await f.manager.release("one")
    expect(f.setKeepAlive).toHaveBeenLastCalledWith(true)
    await f.manager.release("two")
    expect(f.setKeepAlive).toHaveBeenLastCalledWith(false)
  })
  it("expires an abandoned lease after a DO restart", async () => {
    const f = fixture()
    await f.manager.acquire("one")
    const [seconds, payload] = f.schedule.mock.calls[0]
    f.advance(seconds * 1000)
    await new RunLeaseManager(f.deps).expire(payload)
    expect(f.setKeepAlive).toHaveBeenLastCalledWith(false)
  })
  it("ignores an older watchdog when the same run renewed its lease", async () => {
    const f = fixture()
    await f.manager.acquire("one")
    const [seconds, old] = f.schedule.mock.calls[0]
    f.advance(1000)
    await f.manager.acquire("one")
    f.advance(seconds * 1000 - 1000)
    await f.manager.expire(old)
    expect(f.setKeepAlive).toHaveBeenLastCalledWith(true)
  })
  it("never enables keepalive if the durable watchdog cannot be scheduled", async () => {
    const f = fixture()
    f.schedule.mockRejectedValueOnce(new Error("alarm unavailable"))
    await expect(f.manager.acquire("one")).rejects.toThrow("alarm unavailable")
    expect(f.setKeepAlive).not.toHaveBeenCalled()
  })
})
