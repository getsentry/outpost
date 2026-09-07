export type SourceMapTarget = "server" | "web"

export type SourceMapBuildEnv = {
  SENTRY_AUTH_TOKEN?: string
  SENTRY_ORG?: string
  SENTRY_SERVER_PROJECT?: string
  SENTRY_WEB_PROJECT?: string
  SENTRY_RELEASE?: string
  SENTRY_URL?: string
}

/** Cloudflare's Vite build names its authored Worker environment `jared`. */
export function sentrySourceMapTargetForEnvironment(environmentName: string): SourceMapTarget | undefined {
  if (environmentName === "jared") return "server"
  if (environmentName === "client") return "web"
  return undefined
}

/**
 * Build-time only configuration. These variables are intentionally read from
 * process.env by Vite and are never exposed as Worker bindings or VITE_* vars.
 */
export function sentrySourceMapPluginOptions(target: SourceMapTarget, env: SourceMapBuildEnv) {
  const project = target === "server" ? env.SENTRY_SERVER_PROJECT : env.SENTRY_WEB_PROJECT
  // Do not let the plugin infer a Git release: it can differ from the Worker
  // version that emits the event. Upload only with the explicit value the
  // runtime uses, so source maps resolve against the same release.
  if (!env.SENTRY_AUTH_TOKEN || !env.SENTRY_ORG || !project || !env.SENTRY_RELEASE) return undefined

  return {
    authToken: env.SENTRY_AUTH_TOKEN,
    org: env.SENTRY_ORG,
    project,
    url: env.SENTRY_URL,
    telemetry: false,
    release: { name: env.SENTRY_RELEASE },
    sourcemaps: {
      assets: target === "server" ? ["dist/jared/**/*.js"] : ["dist/client/**/*.js"],
      filesToDeleteAfterUpload: target === "server" ? ["dist/jared/**/*.map"] : ["dist/client/**/*.map"],
    },
  }
}
