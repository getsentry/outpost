# fix-ci — Specification

## Intent

Diagnose and fix failing CI on a PR the bot authored until it is green or has a
concrete, evidenced external blocker. Attempt comments are a diagnostic trail,
not a hard stop.

## Scope

### In scope

- Reading CI failure logs
- Categorizing failures (test, type/lint, build, snapshot, flaky, infra)
- Making targeted fixes for test, type, lint, and build failures
- Re-running flaky tests once
- Loading `deslop` and `review` before committing fixes

### Out of scope

- Modifying CI configuration (unless the failure is specifically in it)
- Bumping dependency versions
- Fixing infrastructure issues (BLOCKED)
- Calling a failure unrelated to the bot's changes without evidence from the
  latest default branch

## Invocation

Loaded by `jared` when a `check_suite` or `workflow_run` event
arrives with `conclusion: failure` for a PR the bot authored.
Requires `repo-setup` first.

## Runtime contract

### Input

- PR number and branch (from webhook payload)
- `/workspace/repo` prepared on the PR's branch

### Output

- A fix commit pushed to the branch, or `BLOCKED: <reason>` with the exact
  failed job or check and available log or check output

### Side effects

- Posts `fix-ci: attempt N` comments for diagnostic tracking
- Commits and pushes fixes to the PR branch
- May re-run failed workflows for flaky tests

## Evaluation criteria

- Three unsuccessful attempts trigger fact-finding against the latest default
  branch rather than speculative edits or abandonment
- Fixes are minimal — don't change more than necessary
- Flaky tests are re-run rather than "fixed"
- Infrastructure issues are correctly identified as BLOCKED
- Failures are called pre-existing or unrelated only after the same failure is
  evidenced on the latest default branch, or reproduced after rebasing onto it
- Never close or mark the PR ready while required checks are failing
- The fix actually resolves the CI failure

## Maintenance

- The `gh run view --log-failed` output format may change across `gh` versions
- New CI failure categories may emerge (e.g., security scanning failures)
