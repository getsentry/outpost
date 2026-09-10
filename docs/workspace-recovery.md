# Jared workspace recovery

The native Flue conversation lives in its Durable Object; its Linux workspace
does not. A missing working directory can make the Sandbox SDK report
`posix_spawn '/bin/bash': ENOENT` even when Bash exists. Redeploying or applying
D1 migrations does not restore that directory.

Every native submission holds a keepalive lease while it runs, including model
thinking and delegated work. Completion and failure release it. A durable
Container SDK scheduled callback expires abandoned leases after two hours,
without replacing the SDK's alarm. The normal ten-minute idle timeout then
applies. Keepalive prevents idle sleep, not crashes or platform replacement.

## Recovery contract

Before a sandbox operation, Jared probes from `/`. The guard stores a generation
marker, branch, commit, and fingerprint of the Git index, tracked changes and non-ignored
untracked files in the **brain DO's SQLite storage**, not the disposable
container. It stores hashes, not file contents or credentials. No D1 migration,
new binding, or secret is required.

Untracked symlinks are fingerprinted by their target path, not dereferenced;
regular files also include their executable bit.

When the repo is missing, preparation restores the repository, skills, and GitHub
authentication. Recovery fetches the saved commit from origin and restores its
branch (or detached HEAD), then verifies the fingerprint before continuing.
There are at most two recovery attempts per submission, durable across runtime
reattempts. Initial preparation and deliberate token refresh do not consume that
budget. Shared sandbox operations are serialized to avoid racing checkpoints.

Only failed file reads are retried, once. Shell commands and writes are never
automatically replayed after a transport failure: a push or PR creation may have
already happened. A possibly-executed mutation remains marked uncertain across
brain restarts. A pre-cancelled command never starts or poisons the workspace.
Cancellation stops subsequent preparation steps. Ending an invocation fences
late results, including an abandoned directory creation, so they cannot start
new file writes or overwrite a newer checkpoint. Already-started external work
cannot be undone and remains uncertain until inspected.

This is **not a filesystem backup**. Unpushed commits, non-reproducible local
changes, ignored build artifacts, background processes, and files outside the
repository are not restored. The Git checkpoint verifies tracked/non-ignored
work only. A replacement repo already populated by another caller is verified,
not reset over. A damaged existing repo is not treated as an empty sandbox.
Unrecoverable checkpoints or uncertain mutations stop execution with the typed
`workspace_lost` error. They do not silently restart work on the default branch.

## Blocked runs

The guard stops subsequent tools/model turns and prevents a model's final
"blocked" answer from settling successfully. Session dashboards display
**Blocked: workspace recovery**. Event reconciliation preserves exact failed
and aborted receipts instead of marking every receipt `settled`; workspace
failures become `failed:workspace_lost`. Existing historical completed receipts
are not retroactively changed.

The pinned Flue runtime patch sends completed-but-unsettled submissions through
a fresh attempt and the normal completion guard after a brain restart. Ordinary
saved final responses run finish hooks without replaying the model or tools.
Reconciliation's context discovery makes no sandbox calls outside a guarded run.

Before clearing a blocker, inspect the run and any uncertain external effects
(for example, whether the push or PR creation happened), and save any surviving
local files. Do not repeatedly resend the failed webhook.

An authenticated operator can explicitly acknowledge the loss:

```http
POST /api/containers/<URL-encoded-entity-key>/workspace/acknowledge
Content-Type: application/json

{"runId":"<failed-submission-id>","acknowledgeDataLoss":true}
```

The endpoint requires an inactive conversation, the original workspace failure
receipt (or an explicit abort, timeout, retry exhaustion, or interrupted-input
receipt that superseded it), and an
exact matching durable blocker. Use the error's `meta.workspaceRunId` when a
later submission reports a blocker inherited from an earlier run. It clears only the guard's checkpoint
and uncertainty record; it does not delete the conversation or workspace,
dispatch a new event, or retry any command. A stale acknowledgement returns 409.
The brain DO checks Flue's authoritative submission table and clears the blocker
synchronously, so a newly admitted run invalidates an earlier inactive-history
read. This is a read-only dependency on the pinned Flue schema: missing schema
or unknown active statuses fail closed, with installed-runtime compatibility tests.
After inspection and acknowledgement, send explicit operator guidance or resend
the desired event separately. Without acknowledgement, an uncertain mutation
continues to block automatic work.

## Validation and rollout

Tests reproduce a missing cwd with a real shell, recover an exact Git branch and
commit against a local origin, and persist checkpoints in real SQLite. Runtime
adapter tests cover swallowed tool failures, delegation, lease cleanup, and
command options. Lease tests cover restarts and overlapping/renewed leases;
operator-route tests cover authentication, consent, stale state, and active runs.

After deployment, validate with a disposable test issue: allow a read-only run
to begin, remove its test workspace between tool calls, and verify bounded
recovery without losing its branch. Separately test loss after an uncommitted
edit and a transport failure during a mutation; both must stop as blocked. Check
the final Flue receipt and event reconciliation, not only the model's text.
