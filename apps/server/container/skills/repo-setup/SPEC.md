# repo-setup — Specification

## Intent

Prepare the container's target repository checkout at `/workspace/repo` on the
right branch for the current issue or PR. This is the prerequisite skill for
every situation skill.

## Scope

### In scope

- Refreshing refs in `/workspace/repo`
- Determining the correct branch name from issue or PR context
- Switching `/workspace/repo` to a new issue branch or an existing PR branch
- Preserving in-progress changes on follow-up events when already on the right
  branch

### Out of scope

- Creating git worktrees or cloning a second copy of the target repo
- Installing dependencies or running setup scripts (the situation skill handles that)
- Making any code changes
- Pushing or committing

## Invocation

Loaded first by `jared` before every situation skill. Every code-touching
workflow starts with `repo-setup`.

## Runtime contract

### Input

- Repository identifier (`owner/repo`)
- Context: issue number (for new branches) or PR number (for existing branches)

### Output

- `/workspace/repo` exists and is a git repository
- `/workspace/repo` is on the intended branch
- The agent uses `/workspace/repo` as the working directory for all subsequent
  commands

### Side effects

- Fetches refs from the remote
- Creates or updates a local branch in `/workspace/repo`
- Does not create worktrees

## Evaluation criteria

- The target repo is edited in `/workspace/repo`, matching OpenCode's project
  root and snapshots
- New issue work starts from the default branch on `issue-<number>-<slug>`
- Existing PR work checks out the PR head branch
- Follow-up events do not discard dirty in-progress work on the correct branch
- `git status` in `/workspace/repo` is understandable before the situation
  skill proceeds

## Maintenance

- Keep `/workspace/repo` as the only target-repo checkout unless the container
  lifecycle changes. Multi-repo investigation may still clone other repos under
  `~/dev/...` for read-only context.
- The container runtime already clones the target repo before OpenCode starts;
  if that changes, update this skill and the runtime together.
