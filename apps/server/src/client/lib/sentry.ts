import * as Sentry from "@sentry/react"
import { browserSentryOptions } from "./sentry-config"

Sentry.init({
  ...browserSentryOptions(import.meta.env),
  integrations: [Sentry.browserTracingIntegration(), Sentry.replayIntegration()],
  beforeBreadcrumb: () => null,
  beforeSend: (event) => ({
    ...event,
    request: undefined,
    breadcrumbs: undefined,
    message: event.message ? "[redacted]" : undefined,
    exception: event.exception
      ? {
          ...event.exception,
          values: event.exception.values?.map((value) => ({
            type: value.type,
            value: "[redacted]",
            mechanism: value.mechanism,
          })),
        }
      : undefined,
  }),
})
