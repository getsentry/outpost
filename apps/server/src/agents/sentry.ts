import { env } from "cloudflare:workers"
import { createOpenTelemetryInstrumentation } from "@flue/opentelemetry"
import { type FlueObservation, instrument } from "@flue/runtime"
import * as Sentry from "@sentry/cloudflare"
import {
  contentPolicy,
  createTerminalFailureDeduper,
  runtimeSentryConfig,
  safeSentryAttributes,
  safeSentryLogAttributes,
  terminalFailureCorrelationTags,
} from "@/lib/observability/sentry"

type AgentSentryEnv = {
  ENV?: string
  SENTRY_ENVIRONMENT?: string
  SENTRY_TRACES_SAMPLE_RATE?: string
  SENTRY_AI_RECORD_INPUTS?: string
  SENTRY_AI_RECORD_OUTPUTS?: string
  DB?: D1Database
}

const agentEnv = (env as unknown as AgentSentryEnv) ?? {}
const config = runtimeSentryConfig({ ...agentEnv, SENTRY_ENVIRONMENT: agentEnv.SENTRY_ENVIRONMENT ?? agentEnv.ENV })
const shouldCaptureTerminalFailure = createTerminalFailureDeduper()
const terminalCorrelationLookupAttempts = 5

function flueTags(event: FlueObservation): Record<string, string> {
  const tags: Record<string, string> = { "jared.source": "flue_runtime" }
  if (event.submissionId) tags["flue.submission.id"] = event.submissionId
  if (event.instanceId) tags["flue.instance.id"] = event.instanceId
  if (event.agentName) tags["flue.agent.name"] = event.agentName
  if (event.conversationId) tags["flue.conversation.id"] = event.conversationId
  if (event.operationId) tags["flue.operation.id"] = event.operationId
  return tags
}

async function terminalLifecycleCorrelation(event: Extract<FlueObservation, { type: "submission_settled" }>) {
  if (!agentEnv.DB) return { submissionId: event.submissionId, instanceId: event.instanceId }

  try {
    // A very fast terminal failure can arrive before the Worker commits the
    // admission receipt. Retry the immutable mapping briefly; reconciliation
    // can freely overwrite status without affecting this lookup.
    let delivery: { id: string; entity_key: string } | null = null
    for (let attempt = 0; attempt < terminalCorrelationLookupAttempts; attempt++) {
      delivery = await agentEnv.DB.prepare(
        "SELECT id, entity_key FROM webhook_events WHERE flue_submission_id = ? LIMIT 1",
      )
        .bind(event.submissionId)
        .first<{ id: string; entity_key: string }>()
      if (delivery || attempt === terminalCorrelationLookupAttempts - 1) break
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)))
    }
    const lifecycle = event.instanceId
      ? await agentEnv.DB.prepare("SELECT generation FROM agent_lifecycle WHERE instance_id = ? LIMIT 1")
          .bind(event.instanceId)
          .first<{ generation: number }>()
      : null
    return {
      submissionId: event.submissionId,
      instanceId: event.instanceId,
      entityKey: delivery?.entity_key,
      eventId: delivery?.id,
      generation: lifecycle?.generation,
    }
  } catch {
    // Terminal error reporting must not be blocked by a contained D1 lookup.
    return { submissionId: event.submissionId, instanceId: event.instanceId }
  }
}

async function captureSettledSubmissionFailure(event: Extract<FlueObservation, { type: "submission_settled" }>) {
  if (event.outcome !== "failed" || !shouldCaptureTerminalFailure(event.submissionId)) return

  const errorType = event.errorInfo?.type ?? event.error?.type ?? "unknown"
  const lifecycleTags = terminalFailureCorrelationTags(await terminalLifecycleCorrelation(event))
  Sentry.withScope((scope) => {
    scope.setTags({ ...flueTags(event), ...lifecycleTags })
    scope.setContext(
      "flue_terminal_failure",
      safeSentryAttributes({
        failure_type: errorType,
        failure_name: event.errorInfo?.name ?? event.error?.name,
        outcome: event.outcome,
      }),
    )
    // Never pass the runtime error object: it can contain model/tool text,
    // shell commands, repository content, or a raw stack. The correlation tags
    // retain the diagnostic join without exporting that content.
    const safeError = new Error(`Flue terminal failure (${errorType})`)
    safeError.name = "FlueTerminalFailure"
    Sentry.captureException(safeError)
  })
}

function forwardFlueLog(event: Extract<FlueObservation, { type: "log" }>) {
  const attributes = safeSentryLogAttributes({ ...flueTags(event), level: event.level })
  // Event messages may be built from prompts, tool output, or shell stderr;
  // preserve level and correlation but not the message itself.
  Sentry.logger[event.level]("flue.runtime.log", attributes)
}

if (config.tracesSampleRate > 0) {
  instrument(createOpenTelemetryInstrumentation({ content: contentPolicy(env as unknown as AgentSentryEnv) }))
}

instrument({
  key: Symbol.for("jared.sentry.flue.bridge"),
  async observe(event) {
    if (event.type === "submission_settled") await captureSettledSubmissionFailure(event)
    if (event.type === "log") forwardFlueLog(event)
  },
  interceptor: (_operation, _ctx, next) => next(),
  async dispose() {
    await Sentry.flush(2_000)
  },
})
