import { describe, expect, it } from "vitest"
import { isTransientSandboxError } from "../dispatch"

describe("isTransientSandboxError", () => {
  it("treats sandbox session/DO resets and 5xx as transient (worth a retry)", () => {
    for (const msg of [
      "Session 'sandbox-getsentry-spotlight-1346' shell exited (exit code: 0)",
      "SessionTerminatedError: shell exited",
      "Durable Object reset because its code was updated",
      "Internal error in Durable Object storage caused object to be reset",
      "Network connection lost",
      "SandboxError: HTTP error! status: 500",
      "HTTP error! status: 503",
      "sandbox not running",
      "Default session initialization was invalidated by a container stop",
    ]) {
      expect(isTransientSandboxError(new Error(msg)), msg).toBe(true)
    }
  })

  it("does not retry real command failures / 4xx", () => {
    for (const msg of [
      "git clone failed: fatal: repository not found",
      "HTTP error! status: 404",
      "HTTP error! status: 403",
      "permission denied",
      "Default session initialization was invalidated by a container stop due to invalid configuration",
    ]) {
      expect(isTransientSandboxError(new Error(msg)), msg).toBe(false)
    }
  })

  it("handles non-Error values without throwing", () => {
    expect(isTransientSandboxError("shell exited")).toBe(true)
    expect(isTransientSandboxError(null)).toBe(false)
    expect(isTransientSandboxError(undefined)).toBe(false)
  })
})
