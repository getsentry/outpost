import { runtimeSentryConfig, type SentryRuntimeEnv, safeSentryAttributes, safeSentryLogAttributes } from "./sentry"

type SentryBindings = SentryRuntimeEnv & {
  SENTRY_DSN?: string
  SENTRY_RELEASE?: string
  ENV?: string
}

/**
 * Sentry initialization shared by the authored Worker and Jared Durable
 * Object. RPC propagation is deliberately enabled on both sides; Flue queue
 * admissions remain asynchronous and are correlated by submission ID instead.
 */
export function cloudflareSentryOptions(bindings: SentryBindings) {
  const config = runtimeSentryConfig({
    ...bindings,
    SENTRY_ENVIRONMENT: bindings.SENTRY_ENVIRONMENT ?? bindings.ENV,
  })
  return {
    dsn: bindings.SENTRY_DSN,
    enabled: Boolean(bindings.SENTRY_DSN),
    environment: config.environment,
    // Leave this key out when no explicit release is configured. The
    // Cloudflare SDK can then use CF_VERSION_METADATA.id, whereas an explicit
    // `undefined` prevents that fallback. Source-map uploads require the
    // explicit release value so uploaded artifacts and runtime events match.
    ...(bindings.SENTRY_RELEASE ? { release: bindings.SENTRY_RELEASE } : {}),
    tracesSampleRate: config.tracesSampleRate,
    traceLifecycle: "stream" as const,
    streamGenAiSpans: true,
    enableLogs: true,
    enableRpcTracePropagation: true,
    sendDefaultPii: false,
    beforeBreadcrumb: () => null,
    beforeSendLog: (log: { level: string; message: unknown; attributes?: Record<string, unknown> }) => ({
      ...log,
      // Sentry Logs are metadata-only for Jared. Flue's original log text can
      // carry prompts, tool output, commands, or repo content.
      message: "[redacted]",
      attributes: safeSentryLogAttributes(log.attributes ?? {}),
    }),
    beforeSend: (event: Record<string, unknown>) => {
      const exception = event.exception as { values?: Array<Record<string, unknown>> } | undefined
      return {
        ...event,
        request: undefined,
        breadcrumbs: undefined,
        message: event.message ? "[redacted]" : undefined,
        extra:
          event.extra && typeof event.extra === "object"
            ? safeSentryAttributes(event.extra as Record<string, unknown>)
            : event.extra,
        exception: exception
          ? {
              ...exception,
              values: exception.values?.map((value) => ({
                type: value.type,
                value: "[redacted]",
                mechanism: value.mechanism,
              })),
            }
          : undefined,
      }
    },
  }
}
