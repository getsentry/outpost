import { describe, expect, it } from "vitest"
import { isTransientHistoryError } from "../flue-dispatch"

describe("isTransientHistoryError", () => {
  it("treats network/timeout/5xx/429 as transient (worth a quick retry)", () => {
    for (const msg of [
      "fetch failed",
      "network error",
      "request timed out",
      "socket timeout",
      "ECONNRESET while reading",
      "HTTP 502 Bad Gateway",
      "503 Service Unavailable",
      "504 Gateway Timeout",
      "429 Too Many Requests",
    ]) {
      expect(isTransientHistoryError(new Error(msg)), msg).toBe(true)
    }
  })

  it("does not retry 404 (conversation not materialized yet) or auth failures", () => {
    for (const msg of ["404 Not Found", "conversation not found", "401 Unauthorized", "403 Forbidden"]) {
      expect(isTransientHistoryError(new Error(msg)), msg).toBe(false)
    }
  })

  it("handles non-Error values without throwing", () => {
    expect(isTransientHistoryError("fetch failed")).toBe(true)
    expect(isTransientHistoryError(null)).toBe(false)
    expect(isTransientHistoryError(undefined)).toBe(false)
  })
})
