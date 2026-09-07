import { describe, expect, it } from "vitest"
import {
  classifySandboxPreparationFailure,
  contentPolicy,
  createTerminalFailureDeduper,
  runtimeSentryConfig,
  safeSentryAttributes,
  safeSentryLogAttributes,
  sandboxPreparationAttributes,
  terminalFailureCorrelationTags,
  workflowCorrelationTags,
} from "../sentry"

describe("Jared Sentry observability policy", () => {
  it("captures each terminal Flue submission failure exactly once", () => {
    const shouldCapture = createTerminalFailureDeduper()

    expect(shouldCapture("sub_123")).toBe(true)
    expect(shouldCapture("sub_123")).toBe(false)
    expect(shouldCapture("sub_456")).toBe(true)
  })

  it("keeps lifecycle correlation metadata on workflow telemetry", () => {
    expect(
      workflowCorrelationTags({
        source: "reconciliation",
        submissionId: "sub_123",
        entityKey: "getsentry/outpost#161",
        eventId: "evt_456",
        generation: 7,
        lifecycleStatus: "settled",
      }),
    ).toEqual({
      "jared.source": "reconciliation",
      "flue.submission.id": "sub_123",
      "jared.entity_key": "getsentry/outpost#161",
      "jared.event_id": "evt_456",
      "jared.agent_generation": 7,
      "jared.lifecycle_status": "settled",
    })
  })

  it("keeps exact terminal failures joined to their webhook lifecycle", () => {
    expect(
      terminalFailureCorrelationTags({
        submissionId: "sub_123",
        instanceId: "jared-161",
        entityKey: "getsentry/outpost#161",
        eventId: "evt_456",
        generation: 7,
      }),
    ).toMatchObject({
      "flue.submission.id": "sub_123",
      "flue.instance.id": "jared-161",
      "jared.entity_key": "getsentry/outpost#161",
      "jared.event_id": "evt_456",
      "jared.agent_generation": 7,
      "jared.lifecycle_status": "failed",
    })
  })

  it("makes sandbox preparation a metadata-only span with a stable failure class", () => {
    expect(
      sandboxPreparationAttributes({
        source: "worker_dispatch",
        sandboxId: "jared-161",
        entityKey: "getsentry/outpost#161",
        eventId: "evt_456",
      }),
    ).toMatchObject({
      "jared.source": "worker_dispatch",
      "jared.sandbox_id": "jared-161",
      "jared.entity_key": "getsentry/outpost#161",
      "jared.event_id": "evt_456",
      "jared.sandbox.phase": "thin_preparation",
    })
    expect(classifySandboxPreparationFailure(new Error("HTTP error! status: 503"))).toBe("transient_infrastructure")
    expect(classifySandboxPreparationFailure(new Error("thin sandbox prep failed: git clone failed"))).toBe(
      "preparation_failed",
    )
  })

  it("redacts secrets and keeps model/tool content disabled by default", () => {
    expect(
      safeSentryAttributes({
        status: "admitted",
        authorization: "Bearer top-secret",
        command: "git clone https://token@github.com/private/repo",
        nested: { apiKey: "sk-secret", useful: "keep" },
      }),
    ).toEqual({
      status: "admitted",
      authorization: "[REDACTED]",
      command: "[REDACTED]",
      nested: { apiKey: "[REDACTED]", useful: "keep" },
    })
    expect(contentPolicy({})).toBe(false)
    expect(
      safeSentryLogAttributes({
        "flue.submission.id": "sub_123",
        "jared.source": "flue_runtime",
        detail: "a model response that is not secret-shaped",
        user: { email: "person@example.com" },
      }),
    ).toEqual({
      "flue.submission.id": "sub_123",
      "jared.source": "flue_runtime",
    })
    expect(runtimeSentryConfig({ SENTRY_ENVIRONMENT: "staging" }).tracesSampleRate).toBe(1)
    expect(runtimeSentryConfig({ SENTRY_ENVIRONMENT: "production" }).tracesSampleRate).toBe(0.1)
  })
})
