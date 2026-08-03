import { describe, expect, it } from "vitest"
import {
  FLUE_INTERNAL_HEADER,
  requestHasFlueInternalToken,
  resolveFlueInternalToken,
} from "../../middlewares/flue-auth"

describe("flue internal auth", () => {
  it("prefers FLUE_INTERNAL_TOKEN over BETTER_AUTH_SECRET", () => {
    expect(
      resolveFlueInternalToken({
        FLUE_INTERNAL_TOKEN: "internal",
        BETTER_AUTH_SECRET: "auth",
      }),
    ).toBe("internal")
  })

  it("falls back to BETTER_AUTH_SECRET", () => {
    expect(resolveFlueInternalToken({ BETTER_AUTH_SECRET: "auth" })).toBe("auth")
  })

  it("returns null when no secret is configured", () => {
    expect(resolveFlueInternalToken({})).toBeNull()
  })

  it("accepts a matching header value", () => {
    expect(
      requestHasFlueInternalToken("secret", {
        FLUE_INTERNAL_TOKEN: "secret",
      }),
    ).toBe(true)
    expect(FLUE_INTERNAL_HEADER).toBe("x-flue-internal-token")
  })

  it("rejects mismatched or missing tokens", () => {
    expect(requestHasFlueInternalToken("nope", { FLUE_INTERNAL_TOKEN: "secret" })).toBe(false)
    expect(requestHasFlueInternalToken(undefined, { FLUE_INTERNAL_TOKEN: "secret" })).toBe(false)
  })
})
