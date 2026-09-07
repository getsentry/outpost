export type BrowserSentryEnv = {
  MODE: string
  VITE_SENTRY_DSN?: string
  VITE_SENTRY_ENVIRONMENT?: string
  VITE_SENTRY_RELEASE?: string
  VITE_SENTRY_TRACES_SAMPLE_RATE?: string
  VITE_JARED_API_ORIGIN?: string
}

function sampleRate(value: string | undefined, environment: string): number {
  if (value !== undefined && value.trim() !== "") {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return Math.min(1, Math.max(0, parsed))
  }
  return environment === "production" ? 0.1 : environment === "staging" ? 1 : 0
}

/** Browser-only defaults: error replay, metadata-only tracing, same API origin. */
export function browserSentryOptions(env: BrowserSentryEnv) {
  const environment = env.VITE_SENTRY_ENVIRONMENT ?? env.MODE
  return {
    dsn: env.VITE_SENTRY_DSN,
    enabled: Boolean(env.VITE_SENTRY_DSN),
    environment,
    // Omit this when no public override is configured so the Sentry Vite
    // plugin's injected __SENTRY_RELEASE__ default remains intact.
    ...(env.VITE_SENTRY_RELEASE ? { release: env.VITE_SENTRY_RELEASE } : {}),
    tracesSampleRate: sampleRate(env.VITE_SENTRY_TRACES_SAMPLE_RATE, environment),
    tracePropagationTargets: env.VITE_JARED_API_ORIGIN ? [env.VITE_JARED_API_ORIGIN] : [],
    replaysOnErrorSampleRate: 1,
    replaysSessionSampleRate: 0,
    sendDefaultPii: false,
  }
}
