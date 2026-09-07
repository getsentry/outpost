# Agent Lifecycle Reliability Design

## Goal

Make each Jared webhook delivery auditable and safe across sandbox reuse, durable-agent follow-ups, destruction, and scheduler reconciliation.

## Scope

This change covers the application contracts that caused the observed production failures:

- no completion inferred solely from an idle dashboard read;
- serialized, atomic Phase 2 sandbox preparation for concurrent webhook bursts;
- destroyed runs cannot execute a delayed durable follow-up or resume an old generation;
- a failed DO preparation prevents an agent turn from running in an incomplete workspace;
- cron execution records a health heartbeat and reports stale dispatch reconciliation separately from delivery outcomes;
- session adaptation bounds retained tool output and reports the model/cost metadata the runtime actually provides.

Activating or repairing the deployed Cloudflare cron trigger is a release operation, not a source-code change. The deployment checklist must verify the trigger and heartbeat after this PR is deployed.

## Delivery state contract

`webhook_events.status` remains a string for backward compatibility but gains clear lifecycle values:

`pending` → `d:boot` → `d:setup_done` → `d:prompt` → `admitted:<submissionId>` → `settled`

`failed:<reason>`, `skipped`, and `cancelled:destroyed` are terminal alternatives.

`completed` is reserved for a delivery whose GitHub-side result has been independently verified. Existing discussion obligations already provide that evidence through their webhook verification path. A generic webhook with no independently verifiable external result ends as `settled`, not `completed`.

The dispatch record stores the returned Flue submission id. Reconciliation reads the DO history and only settles an admitted row whose submission id has a matching settlement. It never upgrades every event for an entity merely because the agent happens to be idle.

## Sandbox preparation

The thin-sandbox setup uses one entity-scoped filesystem lock for the complete critical section: clone, git identity, atomic environment-file replacement (including `GH_TOKEN`), workspace-skill copy, and verification. A caller that fails to acquire the lock times out rather than modifying a peer's setup. The warm path also uses the same critical section so a token refresh cannot race an incoming setup.

The environment is emitted as one complete temporary file and atomically renamed. No independent `grep`/append operation may rewrite it after the verification step.

## Durable-agent lifecycle

Destroying a run writes a tombstone for the canonical agent id before removing its session and event records, then destroys the sandbox. Scheduled follow-ups carry the creation generation. `runFollowUp` reads the tombstone/generation and drops invalid work; a newly admitted webhook clears the tombstone and starts a fresh generation. This permits intentional reuse of an entity key while preventing old schedules from resurrecting a destroyed run.

`useAgentStart` does not swallow a preparation error. It reports the error and rejects the turn, allowing Flue to settle it as failed rather than asking the model to work in an empty sandbox.

## Scheduler health and reconciliation

The scheduled handler writes a small `maintenance_runs` heartbeat after its maintenance pass, with the observed cron name, run timestamp, and outcome counters. The API exposes its latest heartbeat with event statistics so the dashboard/operator can distinguish an idle agent from a non-running scheduler.

For stale admitted deliveries, reconciliation maps settled submission ids to `settled`. It records a timeout only when the live history is unavailable or the specific submission is still open after the cutoff. It does not create `completed` rows.

## Session resource data

The adapter preserves model and cost when Flue supplies them. It also truncates oversized tool output to a bounded preview with original-byte metadata, keeping full output out of the durable dashboard/session blob. Tool result summaries remain useful to the agent operator while reducing compaction and storage pressure.

## Testing

Tests cover:

- mapping a specific Flue settlement to its delivery while leaving unrelated deliveries unchanged;
- preserving `completed` for independently verified outcomes and never manufacturing it from idle state;
- full-prep lock and atomic env construction behavior through generated shell-script assertions;
- failed DO prep rejecting the turn rather than continuing;
- destruction tombstone/generation decisions for scheduled work;
- scheduler heartbeat persistence and result accounting;
- tool-output truncation and model/cost adaptation.

Run the server test suite, server typecheck/lint, and the worker build. Before release, verify a new cron heartbeat arrives in production and that a destroyed run does not dispatch its pending follow-up.
