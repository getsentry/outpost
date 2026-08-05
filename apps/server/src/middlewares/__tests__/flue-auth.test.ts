import { describe, expect, it } from "vitest"
import {
  FLUE_INTERNAL_HEADER,
  requestHasFlueInternalToken,
  resolveFlueInternalToken,
  timingSafeEqualString,
} from "../../middlewares/flue-auth"

describe("flue internal auth", () => {
  it("prefers FLUE_INTERNAL_TOKEN over a derived secret", async () => {
    expect(
      await resolveFlueInternalToken({
        FLUE_INTERNAL_TOKEN: "internal",
        BETTER_AUTH_SECRET: "auth",
      }),
    ).toBe("internal")
  })

  it("derives a purpose-bound token instead of returning BETTER_AUTH_SECRET", async () => {
    const derived = await resolveFlueInternalToken({ BETTER_AUTH_SECRET: "auth-secret" })
    expect(derived).toBeTruthy()
    expect(derived).not.toBe("auth-secret")
    // Stable across calls.
    expect(await resolveFlueInternalToken({ BETTER_AUTH_SECRET: "auth-secret" })).toBe(derived)
  })

  it("returns null when no secret is configured", async () => {
    expect(await resolveFlueInternalToken({})).toBeNull()
  })

  it("accepts a matching header value with constant-time compare", async () => {
    expect(
      await requestHasFlueInternalToken("secret", {
        FLUE_INTERNAL_TOKEN: "secret",
      }),
    ).toBe(true)
    expect(FLUE_INTERNAL_HEADER).toBe("x-flue-internal-token")
    expect(timingSafeEqualString("abc", "abc")).toBe(true)
    expect(timingSafeEqualString("abc", "abd")).toBe(false)
    expect(timingSafeEqualString("abc", "ab")).toBe(false)
  })

  it("rejects mismatched or missing tokens", async () => {
    expect(await requestHasFlueInternalToken("nope", { FLUE_INTERNAL_TOKEN: "secret" })).toBe(false)
    expect(await requestHasFlueInternalToken(undefined, { FLUE_INTERNAL_TOKEN: "secret" })).toBe(false)
  })
})
