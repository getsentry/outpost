# Workspace probe recovery implementation plan

> **For agentic workers:** Use the test-driven-development workflow and request an independent full-branch review before merging. Implementation is in the existing checkout, as requested.

**Goal:** Survive transient read-only health-probe failures without weakening uncertain-write protection, and preserve useful secret-safe failure evidence.

**Architecture:** Classify probe failures at the sandbox boundary; retry only transient transport failures and timeouts. The brain's existing durable workspace guard remains the owner of blocking and checkpoint state. Never replay commands or writes or automatically acknowledge an existing blocker.

**Tech stack:** TypeScript, Cloudflare Sandbox 0.12, Flue 2.0.1, Vitest, SQLite.

**Spec:** `docs/workspace-recovery.md`, plus the requested fix/review/merge workflow. The exact original platform failure is unknown: the saved receipt discarded it, and historical log access failed. This change fixes that observability gap and the reproducible permanent block on a single transient probe failure.

## Constraints

- Preserve the 30-second per-probe deadline; allow at most three attempts with bounded backoff.
- Retry read-only probes only; preserve preparation budget, generation checks, and unknown-write blockers.
- Diagnostics contain only allowlisted kind, bounded numeric exit code, and attempt count. No raw command, stderr, error message, token, or repository contents.
- Cancellation or ownership changes stop subsequent probes, preparation, and tools.
- Existing blockers require operator acknowledgment; merging alone does not recover production.
- Cloudflare build failure is explicitly excluded from the merge gate. All other checks and actionable review findings must pass.
- Chat-panel work starts separately after this PR merges.

## Task 1: Probe recovery and diagnostics

**Files:** `workspace-recovery.ts`, `workspace-checkpoint.ts`, a small `workspace-probe.ts` diagnostic module, shared `sandbox-errors.ts`, their tests under `apps/server/src/lib/containers/`, and `docs/workspace-recovery.md`.

**Interfaces:** Preserve `inspectWorkspace(sandbox): Promise<WorkspaceSnapshot | null>` and `WorkspaceRecovery.run`. Add optional plain-object `probeFailure` to workspace state and `meta.workspaceProbe` to the typed failure receipt. Keep old state readable.

- [x] Inspect the merged implementation, SDK contracts, and the failing production receipt.
- [x] Run the current recovery/checkpoint/runtime baseline: 43 tests passed.
- [x] Add failing regressions: transient failure then healthy probe executes a tool once; timeout then healthy probe ignores the old result; repeated failures block with sanitized diagnostics; cancellation/supersession starts no retry; post-write probes never replay the write.

```ts
f.inspect.mockRejectedValueOnce(new Error("Network connection lost"))
const result = f.guard.run(command, true)
await vi.runAllTimersAsync()
expect(await result).toBe("done")
expect(command).toHaveBeenCalledTimes(1)
expect(f.store.read()?.blocked).toBeUndefined()
```

- [x] Run the focused Vitest files and verify these assertions fail against the existing guard (11 expected failures).
- [x] Extract the existing transient sandbox classifier; recognize the installed SDK's structured `RPC_TRANSPORT_ERROR` code for idempotent prep and safe probe retries.
- [x] Return classified errors for nonzero checkpoint commands and invalid checkpoint output. Missing repo remains `null`; damaged repo is not empty.
- [x] Bound retries and persist final diagnostics. Check abort and ownership before every provider call and after every returned result. Log only the classified terminal failure.

```ts
type WorkspaceProbeFailure = {
  kind: "timeout" | "transport" | "command_failed" | "invalid_checkpoint" | "unknown"
  attempts: number
  exitCode?: number
}
```

- [x] Run focused regressions, full server tests (291 passed), Biome, fresh build, and configured TypeScript check.
- [x] Update the recovery contract to explain retries, retained diagnostics, and unchanged acknowledgment requirements.

## Task 2: Review and delivery

- [ ] Commit the coherent fix using a conventional commit; push the feature branch.
- [ ] Create a PR against main with a short reviewer-facing explanation.
- [ ] Start an independent full-branch review covering bugs, cancellation/races, secret leakage, DRY, and missing tests; fix and re-review findings.
- [ ] Check every non-Cloudflare check and unresolved review thread on the final head.
- [ ] Squash-merge only the verified head; fetch and verify the merge commit on main.
- [ ] Begin a separate chat-panel diagnosis/design: preserve message/tool order, show running/error states clearly, and progressively disclose detail without fabricating unavailable reasoning.
