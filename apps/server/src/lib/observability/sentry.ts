/**
 * The safe, shared Sentry contract for Jared.
 *
 * This module deliberately contains no SDK calls so the same policy is used by
 * the Worker, Durable Object, and browser without making secrets or payloads
 * part of an observability event by accident.
 */

export type SentryRuntimeEnv = {
  SENTRY_ENVIRONMENT?: string
  SENTRY_TRACES_SAMPLE_RATE?: string
  SENTRY_AI_RECORD_INPUTS?: string
  SENTRY_AI_RECORD_OUTPUTS?: string
}

export type JaredCorrelation = {
  source: string
  submissionId?: string
  entityKey?: string
  eventId?: string
  generation?: number
  lifecycleStatus?: string
  sandboxId?: string
}

const REDACTED = "[REDACTED]"
const SENSITIVE_KEY =
  /(?:authorization|cookie|token|secret|password|api[_-]?key|dsn|command|prompt|message|output|input|payload|content|repository|repo)/i
const SENSITIVE_VALUE = /(?:bearer\s+\S+|(?:gh[pousr]_|github_pat_|sk-|xox[baprs]-)\S+|https?:\/\/[^\s/@]+@)/i
const SAFE_LOG_ATTRIBUTE = new Set([
  "level",
  "jared.source",
  "jared.entity_key",
  "jared.event_id",
  "jared.agent_generation",
  "jared.lifecycle_status",
  "jared.sandbox_id",
  "jared.sandbox.phase",
  "jared.sandbox.outcome",
  "jared.sandbox.failure_class",
  "flue.submission.id",
  "flue.instance.id",
  "flue.agent.name",
  "flue.conversation.id",
  "flue.operation.id",
  "sentry.trace_id",
  "sentry.trace.parent_span_id",
  "sentry.environment",
  "sentry.release",
])

function enabled(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true"
}

function clampSampleRate(value: string | undefined, environment: string | undefined): number {
  if (value !== undefined && value.trim() !== "") {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return Math.min(1, Math.max(0, parsed))
  }
  return environment === "production" ? 0.1 : environment === "staging" ? 1 : 0
}

/** Runtime defaults are intentionally metadata-only, with explicit deployment sampling. */
export function runtimeSentryConfig(env: SentryRuntimeEnv) {
  const environment = env.SENTRY_ENVIRONMENT ?? "development"
  return {
    environment,
    tracesSampleRate: clampSampleRate(env.SENTRY_TRACES_SAMPLE_RATE, environment),
    recordInputs: enabled(env.SENTRY_AI_RECORD_INPUTS),
    recordOutputs: enabled(env.SENTRY_AI_RECORD_OUTPUTS),
  }
}

type ContentScope = { contentType: string }

/**
 * Flue's OTel adapter treats content as opt-in. When a direction is enabled,
 * retain only that direction and still redact values before export.
 */
export function contentPolicy(env: Pick<SentryRuntimeEnv, "SENTRY_AI_RECORD_INPUTS" | "SENTRY_AI_RECORD_OUTPUTS">) {
  const recordInputs = enabled(env.SENTRY_AI_RECORD_INPUTS)
  const recordOutputs = enabled(env.SENTRY_AI_RECORD_OUTPUTS)
  if (!recordInputs && !recordOutputs) return false as const

  return {
    transform(content: unknown, scope: ContentScope): unknown | undefined {
      const input = ["input_messages", "system_instructions", "tool_definitions", "tool_description", "tool_arguments"]
      const output = ["output_messages", "tool_result", "exception_message", "exception_stacktrace"]
      if (
        (input.includes(scope.contentType) && !recordInputs) ||
        (output.includes(scope.contentType) && !recordOutputs)
      ) {
        return undefined
      }
      return safeSentryValue(content)
    },
  }
}

/** Remove secrets and user/code/tool content from SDK attributes and logs. */
export function safeSentryValue(value: unknown): unknown {
  if (typeof value === "string") return SENSITIVE_VALUE.test(value) ? REDACTED : value
  if (Array.isArray(value)) return value.map(safeSentryValue)
  if (value && typeof value === "object") return safeSentryAttributes(value as Record<string, unknown>)
  return value
}

export function safeSentryAttributes(attributes: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(attributes).map(([key, value]) => [
      key,
      SENSITIVE_KEY.test(key) ? REDACTED : safeSentryValue(value),
    ]),
  )
}

/** Logs are metadata-only: retain only known correlation keys and scalar values. */
export function safeSentryLogAttributes(
  attributes: Record<string, unknown>,
): Record<string, string | number | boolean> {
  return Object.fromEntries(
    Object.entries(attributes).filter(
      ([key, value]): value is string | number | boolean =>
        SAFE_LOG_ATTRIBUTE.has(key) &&
        (typeof value === "string" || typeof value === "number" || typeof value === "boolean"),
    ),
  )
}

/** Tags which connect Worker lifecycle work to an asynchronous Flue submission. */
export function workflowCorrelationTags(correlation: JaredCorrelation): Record<string, string | number> {
  const tags: Record<string, string | number> = { "jared.source": correlation.source }
  if (correlation.submissionId) tags["flue.submission.id"] = correlation.submissionId
  if (correlation.entityKey) tags["jared.entity_key"] = correlation.entityKey
  if (correlation.eventId) tags["jared.event_id"] = correlation.eventId
  if (correlation.generation !== undefined) tags["jared.agent_generation"] = correlation.generation
  if (correlation.lifecycleStatus) tags["jared.lifecycle_status"] = correlation.lifecycleStatus
  if (correlation.sandboxId) tags["jared.sandbox_id"] = correlation.sandboxId
  return tags
}

/** Tags for an exact terminal Flue settlement after its D1 lifecycle lookup. */
export function terminalFailureCorrelationTags(
  correlation: Pick<JaredCorrelation, "submissionId" | "entityKey" | "eventId" | "generation"> & {
    instanceId?: string
  },
): Record<string, string | number> {
  const tags = workflowCorrelationTags({ ...correlation, source: "flue_runtime", lifecycleStatus: "failed" })
  if (correlation.instanceId) tags["flue.instance.id"] = correlation.instanceId
  return tags
}

export function sandboxPreparationAttributes(correlation: JaredCorrelation): Record<string, string | number> {
  return { ...workflowCorrelationTags(correlation), "jared.sandbox.phase": "thin_preparation" }
}

export function classifySandboxPreparationFailure(error: unknown): "transient_infrastructure" | "preparation_failed" {
  const message = error instanceof Error ? error.message : String(error)
  return /session .*?(?:terminat|exit)|durable object reset|network connection lost|HTTP error! status: 5\d\d|sandbox.*(?:not running|stopped|unavailable)/i.test(
    message,
  )
    ? "transient_infrastructure"
    : "preparation_failed"
}

/** A process/isolate-local guard against operation + settlement double capture. */
export function createTerminalFailureDeduper() {
  const captured = new Set<string>()
  return (submissionId: string): boolean => {
    if (captured.has(submissionId)) return false
    captured.add(submissionId)
    return true
  }
}
