import { afterEach, describe, expect, it, vi } from "vitest"
import { destroyAgentWithConfirmation } from "../agent-destruction"

afterEach(() => vi.useRealTimers())

describe("agent deletion confirmation", () => {
  it("does not destroy or probe without an acknowledged preparation", async () => {
    const failure = new Error("preparation failed")
    const rpc = {
      prepareDestroy: vi.fn().mockRejectedValue(failure),
      destroy: vi.fn(),
      isDestroyComplete: vi.fn(),
    }
    await expect(destroyAgentWithConfirmation(() => rpc)).rejects.toBe(failure)
    expect(rpc.destroy).not.toHaveBeenCalled()
    expect(rpc.isDestroyComplete).not.toHaveBeenCalled()
  })

  it("gets a fresh stub after an aborted reply and a transient probe failure", async () => {
    vi.useFakeTimers()
    const prepareDestroy = vi.fn().mockResolvedValue(undefined)
    const destroy = vi.fn().mockRejectedValue(new Error("destroyed"))
    const isDestroyComplete = vi.fn().mockRejectedValueOnce(new Error("resetting")).mockResolvedValue(true)
    const getAgent = vi.fn(() => ({ prepareDestroy, destroy, isDestroyComplete }))
    const result = destroyAgentWithConfirmation(getAgent)
    await vi.runAllTimersAsync()
    await expect(result).resolves.toBeUndefined()
    expect(getAgent).toHaveBeenCalledTimes(4)
  })

  it("bounds unavailable probes and preserves the failure without reporting success", async () => {
    vi.useFakeTimers()
    const failure = new Error("unavailable")
    const rpc = {
      prepareDestroy: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
      isDestroyComplete: vi.fn().mockRejectedValue(failure),
    }
    const result = expect(destroyAgentWithConfirmation(() => rpc)).rejects.toMatchObject({
      message: "Agent storage deletion could not be confirmed",
      cause: failure,
    })
    await vi.runAllTimersAsync()
    await result
    expect(rpc.isDestroyComplete).toHaveBeenCalledTimes(3)
  })
})
