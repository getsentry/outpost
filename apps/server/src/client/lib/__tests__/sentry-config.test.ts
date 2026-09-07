import { describe, expect, it } from "vitest"
import { browserSentryOptions } from "../sentry-config"

describe("browser Sentry configuration", () => {
  it("propagates only to the Jared API origin and records replay only on errors", () => {
    const options = browserSentryOptions({
      MODE: "staging",
      VITE_SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
      VITE_JARED_API_ORIGIN: "https://jared.example.com",
    })

    expect(options.enabled).toBe(true)
    expect(options.tracesSampleRate).toBe(1)
    expect(options.tracePropagationTargets).toEqual(["https://jared.example.com"])
    expect(options.replaysOnErrorSampleRate).toBe(1)
    expect(options.replaysSessionSampleRate).toBe(0)
  })

  it("uses the production sampling policy without a browser DSN", () => {
    const options = browserSentryOptions({ MODE: "production" })

    expect(options.enabled).toBe(false)
    expect(options.tracesSampleRate).toBe(0.1)
    expect(options).not.toHaveProperty("release")
  })
})
