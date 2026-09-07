import { describe, expect, it } from "vitest"
import { cloudflareSentryOptions } from "../cloudflare"

describe("Cloudflare Sentry configuration", () => {
  it("keeps the runtime release unset when no explicit source-map release is configured", () => {
    expect(cloudflareSentryOptions({ ENV: "production" })).not.toHaveProperty("release")
    expect(cloudflareSentryOptions({ ENV: "production", SENTRY_RELEASE: "outpost@42fc09b" })).toMatchObject({
      release: "outpost@42fc09b",
    })
  })
})
