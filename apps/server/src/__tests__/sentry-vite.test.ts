import { describe, expect, it } from "vitest"
import { sentrySourceMapPluginOptions, sentrySourceMapTargetForEnvironment } from "../../sentry-vite"

describe("Sentry source-map build configuration", () => {
  it("only enables an upload when build-only credentials and the target project are configured", () => {
    expect(sentrySourceMapPluginOptions("server", {})).toBeUndefined()
    expect(
      sentrySourceMapPluginOptions("web", {
        SENTRY_AUTH_TOKEN: "build-token",
        SENTRY_ORG: "getsentry",
        SENTRY_WEB_PROJECT: "jared-web",
      }),
    ).toBeUndefined()

    expect(
      sentrySourceMapPluginOptions("web", {
        SENTRY_AUTH_TOKEN: "build-token",
        SENTRY_ORG: "getsentry",
        SENTRY_WEB_PROJECT: "jared-web",
        SENTRY_RELEASE: "outpost@42fc09b",
      }),
    ).toMatchObject({
      org: "getsentry",
      project: "jared-web",
      release: { name: "outpost@42fc09b" },
    })
  })

  it("routes the Vite client and Jared Worker environments to separate projects", () => {
    expect(sentrySourceMapTargetForEnvironment("client")).toBe("web")
    expect(sentrySourceMapTargetForEnvironment("jared")).toBe("server")
    expect(sentrySourceMapTargetForEnvironment("ssr")).toBeUndefined()
  })
})
