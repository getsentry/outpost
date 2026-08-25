---
name: fix-ci
description: Diagnose and fix failing CI on a PR. Load repo-setup first.
license: Apache-2.0
metadata:
  audience: autonomous-agents
---

# Fix CI

Fix failing CI on a PR the bot authored. Load `repo-setup` first.

## Repeated failures

Use `fix-ci: attempt N` comments as a diagnostic trail, not an excuse to stop.
Count existing attempts:

```sh
ATTEMPTS=$(gh api "repos/<owner>/<repo>/issues/<number>/comments" --paginate \
  --jq '[.[] | select(.user.login == "'"$ME"'" and (.body | startswith("fix-ci: attempt")))] | length')
```

Post a short comment like "fix-ci: attempt 2 — looks like a type error in
`foo.ts`, investigating" before starting work. After three unsuccessful code
attempts, stop making speculative changes and re-establish the facts: fetch the
latest default branch, inspect the exact failed job and log again, and either
identify a new targeted fix or report the concrete external blocker. Do not
silently abandon, close, or mark the PR ready.

## Evidence before attribution

Never call a failure pre-existing or unrelated without evidence. Record the
exact failed job, test or error, and log excerpt first. Then compare against the
latest default branch: either show the same failure on that branch, or reproduce
it after rebasing the PR onto it. If the latest default branch is green, treat
the failure as PR-caused until evidence proves otherwise.

Never close a PR or say it is ready while required checks are failing. A flaky
retry or an infrastructure blocker is not a green result; report its evidence
and leave the PR open for the next actionable event.

## Workflow

1. Find failed checks for the PR head: `gh pr checks <number>` and `gh run list --branch <branch> --status failure`.
2. Read GitHub Actions logs with `gh run view <id> --log-failed`. If gh run view returns 404,
   the failed check is external rather than a workflow run; inspect its check output instead:

   ```sh
   gh api "repos/<owner>/<repo>/commits/<SHA>/check-runs" --paginate \
     --jq '.check_runs[] | select(.conclusion == "failure") | {name,details_url,output}'
   ```

   Record the exact failed job or check and its first relevant error, log excerpt,
   or check output in the attempt comment. Do not label an external check as
   infrastructure merely because it has no Actions log.
3. Categorize the failure — see `references/failure-taxonomy.md` for
   the full taxonomy and decision tree. Categories: test failure,
   type/lint error, build error, snapshot diff, flaky test, or infra
   issue.
4. Flaky GitHub Actions run? Re-run once (`gh run rerun <id> --failed`) and stop.
5. Infra/dependency issue? BLOCKED.
6. Otherwise: make the smallest fix. Reproduce locally if possible.
7. Load `deslop` and `review` skills.
8. Commit and push. Verify the remote branch contains the same commit before
   you say the fix is ready:

   ```sh
   git push origin HEAD
   test "$(git rev-parse HEAD)" = "$(git rev-parse @{u})"
   ```

   Then post one comment summarizing what you fixed and how. Write it like a
   teammate explaining the fix, not a status report.
9. Stop after pushing. Do not busy-wait in a polling loop for CI: the next CI
   completion webhook will wake you with the result.

Avoid modifying CI config unless the failure is specifically in it.
Avoid bumping dependency versions — the fix should target the code,
not the toolchain. Don't force-push. Don't merge.
