# Agent Lifecycle Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Jared’s webhook deliveries, sandbox setup, durable follow-ups, and scheduler maintenance evidence-backed and safe across concurrent events and destruction.

**Architecture:** Keep `webhook_events.status` compatible but distinguish agent admission/settlement from verified external completion. Build pure lifecycle helpers around Flue history, then use them at dispatch and reconciliation boundaries. Serialize the complete thin-sandbox setup with one shell critical section, and persist D1 state to invalidate delayed work after destroy.

**Tech Stack:** Cloudflare Workers, D1/Drizzle, Flue Durable Objects, Cloudflare Sandbox, Hono, Vitest, TypeScript.

**Spec:** `docs/superpowers/specs/2026-09-07-agent-lifecycle-reliability-design.md`

## Global Constraints

- `completed` requires independently verified GitHub-side evidence; a settled model turn uses `settled`.
- No dashboard read may mutate webhook delivery status.
- Existing legacy `dispatched` rows remain readable and are retained/expired normally.
- Sandbox credentials are never logged or persisted outside the sandbox environment file.
- Source code cannot claim to activate a Cloudflare cron trigger; release verification must observe a post-deploy heartbeat.

### Task 1: Add exact-delivery settlement status

**Files:**

- Create: `apps/server/src/lib/events/delivery-status.ts`
- Modify: `apps/server/src/lib/github/dispatch.ts`
- Modify: `apps/server/src/lib/events/reconcile.ts`
- Modify: `apps/server/src/routes/containers/index.ts`
- Test: `apps/server/src/lib/events/__tests__/delivery-status.test.ts`
- Test: `apps/server/src/lib/events/__tests__/reconcile.test.ts`

**Interfaces:** `admittedStatus(submissionId?: string): string`, `settledSubmissionIds(history: Record<string, unknown>): Set<string>`, and `reconcileAdmittedDeliveries(...)` update only matching `admitted:<submissionId>` entries to `settled`.

- [ ] Write failing tests that expect `admittedStatus("sub-42")` to equal `"admitted:sub-42"`, and expect a history settlement for `sub-42` to leave an `admitted:sub-99` delivery unchanged.
- [ ] Run `pnpm --filter @jared/server exec vitest run src/lib/events/__tests__/delivery-status.test.ts src/lib/events/__tests__/reconcile.test.ts`; verify failure because neither helper nor exact status update exists.
- [ ] Have `dispatchGitHubEvent` persist `admitted:<submissionId>` from `dispatchToFlueAgent`; reconcile only matching settled submission IDs; remove dashboard-detail calls to `markEntityEventsCompleted`.
- [ ] Re-run the focused tests; verify green.
- [ ] Commit with `git commit -m "fix: reconcile exact agent delivery settlements"`.

### Task 2: Serialize full thin-sandbox setup

**Files:**

- Modify: `apps/server/src/lib/containers/dispatch.ts`
- Test: `apps/server/src/lib/containers/__tests__/thin-prep.test.ts`

**Interfaces:** `buildThinSandboxPrepScript(opts: SandboxSetupOpts): string`; thin `ensureSandboxReady` executes that one script and then verifies it.

- [ ] Write a failing test asserting the generated script contains `LOCK=/workspace/.thin-sandbox-prep.lock`, guarded release, atomic `mv /tmp/flue-env.sh.tmp /tmp/flue-env.sh`, and `export GH_TOKEN=`; assert `bash -n` accepts it.
- [ ] Run `pnpm --filter @jared/server exec vitest run src/lib/containers/__tests__/thin-prep.test.ts`; verify failure because full setup is split across unlocked operations.
- [ ] Move clone, git identity, full environment creation including `GH_TOKEN`, skills copy, and validation into the lock-owning script. Retain retries around the one script and keep phase-1 bootstrap behavior untouched.
- [ ] Re-run the focused test and `bootstrap.test.ts`; verify green.
- [ ] Commit with `git commit -m "fix: serialize complete thin sandbox preparation"`.

### Task 3: Fence destroyed durable work and fail closed

**Files:**

- Create: `apps/server/src/lib/agents/lifecycle.ts`
- Modify: `apps/server/src/db/schema.ts`
- Create: `apps/server/migrations/0002_agent_lifecycle.sql`
- Modify: `apps/server/migrations/meta/_journal.json`
- Modify: `apps/server/src/agents/jared.ts`
- Modify: `apps/server/src/lib/github/dispatch.ts`
- Modify: `apps/server/src/routes/containers/index.ts`
- Test: `apps/server/src/lib/agents/__tests__/lifecycle.test.ts`

**Interfaces:** `startAgentGeneration(db, instanceId)`, `destroyAgentGeneration(db, instanceId)`, and `mayRunFollowUp(db, instanceId, generation)` use `agent_lifecycle(instance_id, generation, destroyed_at, updated_at)`.

- [ ] Write failing tests for a follow-up whose matching generation was destroyed and a new generation that is allowed. Add a test that a DO preparation error is propagated instead of silently converted to a model turn.
- [ ] Run `pnpm --filter @jared/server exec vitest run src/lib/agents/__tests__/lifecycle.test.ts src/lib/containers/__tests__/do-prep.test.ts`; verify failure because no generation/tombstone exists and Jared catches setup errors.
- [ ] Start the generation before webhook admission; destroy it before sandbox/session deletion; capture it in scheduled payload; reject stale schedule payloads before dispatch. Remove the `useAgentStart` catch so preparation rejects the turn.
- [ ] Run focused tests and `pnpm --filter @jared/server exec wrangler d1 migrations apply --local jared --dry-run`; verify green.
- [ ] Commit with `git commit -m "fix: prevent destroyed Jared runs from resuming"`.

### Task 4: Add scheduler health and bounded session output

**Files:**

- Modify: `apps/server/src/db/schema.ts`
- Create: `apps/server/migrations/0003_maintenance_runs.sql`
- Modify: `apps/server/migrations/meta/_journal.json`
- Modify: `apps/server/src/cloudflare.ts`
- Modify: `apps/server/src/routes/events/index.ts`
- Modify: `apps/server/src/lib/containers/flue-session-adapt.ts`
- Test: `apps/server/src/lib/events/__tests__/maintenance.test.ts`
- Test: `apps/server/src/lib/containers/__tests__/flue-session-adapt.test.ts`

**Interfaces:** `maintenance_runs` records a completed cron pass and its counters; `/api/events/stats` returns the latest row; oversized tool output becomes `{ preview, truncated: true, originalBytes }`.

- [ ] Write failing tests that query a recorded maintenance heartbeat and that normalize a 20,000-byte `dynamic-tool` output into a bounded preview with original size.
- [ ] Run `pnpm --filter @jared/server exec vitest run src/lib/events/__tests__/maintenance.test.ts src/lib/containers/__tests__/flue-session-adapt.test.ts`; verify failure because neither behavior exists.
- [ ] Persist the heartbeat after guarded maintenance completes and expose it in event stats. Bound only oversized tool output; preserve small output and model/cost metadata.
- [ ] Re-run focused tests; verify green.
- [ ] Commit with `git commit -m "feat: expose agent maintenance health"`.

### Task 5: Validate and publish

- [ ] Run `pnpm --filter @jared/server lint`, `pnpm --filter @jared/server typecheck`, and `pnpm --filter @jared/server test`; all must pass.
- [ ] Run `pnpm --filter @jared/server exec wrangler d1 migrations apply --local jared` against a disposable local D1 database; all migrations must apply once without drift.
- [ ] Run `git diff origin/main...HEAD --check` and inspect `git status --short` for intended changes only.
- [ ] Push `codex/fix-agent-lifecycle-reliability` and open a PR titled `Fix Jared lifecycle reliability`.
- [ ] In the PR body, require production verification of the cron trigger, a fresh maintenance heartbeat, a CI-burst delivery, and follow-up suppression after destroy.
