// Entity key extraction from GitHub webhook payloads.
//
// Extracts the "entity" (issue or PR) that a webhook event relates to,
// producing a canonical key like "owner/repo#123" for session affinity.
// Also extracts linked issue numbers from PR bodies for cross-referencing.

import type { Octokit } from "@octokit/rest"
import type { EntityKey } from "./types"

// PR-related events that extract from payload.pull_request.
const PR_EVENTS = new Set([
  "pull_request",
  "pull_request_review_comment",
  "pull_request_review",
  // Fired when a review thread is resolved/unresolved. Without this the event
  // returns a null entity and is silently skipped, so the agent never learns a
  // thread changed state.
  "pull_request_review_thread",
])

// CI events that extract from a pull_requests array inside the event object.
const CI_EVENTS: Record<string, string> = {
  check_suite: "check_suite.pull_requests",
  workflow_run: "workflow_run.pull_requests",
}

/**
 * Extract entity key from a GitHub webhook payload.
 * Returns null for events that don't map to a trackable entity.
 *
 * When an Octokit client is provided, events that lack full context
 * (check_suite, workflow_run, push) will make API calls to enrich
 * the entity with linked issues.
 */
export async function extractEntityKey(
  event: string,
  payload: Record<string, unknown>,
  octokit?: Octokit | null,
): Promise<EntityKey | null> {
  const repo = lookupString(payload, "repository.full_name")
  if (!repo) return null

  // issue_comment uses payload.issue (which may be a PR)
  if (event === "issue_comment") {
    const num = lookupNumber(payload, "issue.number")
    if (num === null) return null
    const isPR = lookup(payload, "issue.pull_request") != null
    const body = isPR ? (lookupString(payload, "issue.body") ?? "") : ""
    return {
      key: `${repo}#${num}`,
      repo,
      number: num,
      kind: isPR ? "pull_request" : "issue",
      linkedIssues: extractLinkedIssues(body, repo),
    }
  }

  // issues.*
  if (event === "issues") {
    const num = lookupNumber(payload, "issue.number")
    if (num === null) return null
    return {
      key: `${repo}#${num}`,
      repo,
      number: num,
      kind: "issue",
      linkedIssues: [],
    }
  }

  // pull_request, pull_request_review_comment, pull_request_review, pull_request_review_thread
  // When a PR links to an issue (e.g. "Fixes #123"), use the issue number
  // as the entity key so the PR shares the same container/session as the issue.
  if (PR_EVENTS.has(event)) {
    const num = lookupNumber(payload, "pull_request.number")
    if (num === null) return null
    const body = lookupString(payload, "pull_request.body") ?? ""
    const linkedIssues = extractLinkedIssues(body, repo)
    const entityNumber = linkedIssues.length > 0 ? linkedIssues[0] : num
    const entityKind = linkedIssues.length > 0 ? "issue" : "pull_request"
    return {
      key: `${repo}#${entityNumber}`,
      repo,
      number: entityNumber,
      kind: entityKind as "issue" | "pull_request",
      linkedIssues,
    }
  }

  // check_suite, workflow_run — extract from pull_requests array,
  // fetch PR body for linked issue detection.
  // Skip CI events triggered by pushes to the default branch — the
  // pull_requests array contains stale/unrelated PRs in that case.
  const ciPath = CI_EVENTS[event]
  if (ciPath) {
    // Determine if this CI run is for the default branch (push-triggered)
    const ciObj = lookup(payload, event) as Record<string, unknown> | null
    const headBranch = typeof ciObj?.head_branch === "string" ? ciObj.head_branch : null
    const defaultBranch = lookupString(payload, "repository.default_branch")
    if (headBranch && defaultBranch && headBranch === defaultBranch) {
      // Push to default branch — pull_requests array is unreliable
      return null
    }

    const prs = lookup(payload, ciPath)
    if (!Array.isArray(prs) || prs.length === 0) return null
    const first = prs[0] as Record<string, unknown>
    const num = typeof first?.number === "number" ? first.number : null
    if (num === null) return null
    const linkedIssues = octokit ? await fetchLinkedIssues(octokit, repo, num) : []
    // Use linked issue number if available (same container as the issue)
    const entityNumber = linkedIssues.length > 0 ? linkedIssues[0] : num
    const entityKind = linkedIssues.length > 0 ? "issue" : "pull_request"
    return {
      key: `${repo}#${entityNumber}`,
      repo,
      number: entityNumber,
      kind: entityKind as "issue" | "pull_request",
      linkedIssues,
    }
  }

  // push — resolve branch to PR, or parse commit messages for issue refs
  if (event === "push") {
    return resolvePushEntity(payload, repo, octokit)
  }

  return null
}

/**
 * Fetch a PR's body via Octokit and extract linked issues from it.
 */
async function fetchLinkedIssues(octokit: Octokit, repo: string, prNumber: number): Promise<number[]> {
  try {
    const [owner, repoName] = repo.split("/")
    const { data } = await octokit.pulls.get({
      owner,
      repo: repoName,
      pull_number: prNumber,
    })
    if (!data.body) return []
    return extractLinkedIssues(data.body, repo)
  } catch {
    return []
  }
}

/**
 * Resolve a push event to an entity by:
 *   1. Looking up the open PR for the pushed branch
 *   2. Falling back to parsing commit messages for "Fixes #N" refs
 */
async function resolvePushEntity(
  payload: Record<string, unknown>,
  repo: string,
  octokit?: Octokit | null,
): Promise<EntityKey | null> {
  const ref = lookupString(payload, "ref")

  // Try to find the PR for this branch via API
  if (octokit && ref?.startsWith("refs/heads/")) {
    const branch = ref.slice("refs/heads/".length)
    try {
      const [owner, repoName] = repo.split("/")
      const { data: prs } = await octokit.pulls.list({
        owner,
        repo: repoName,
        head: `${owner}:${branch}`,
        state: "open",
        per_page: 1,
      })
      if (prs.length > 0) {
        const pr = prs[0]
        const linkedIssues = pr.body ? extractLinkedIssues(pr.body, repo) : []
        // Use linked issue number if available (same container as the issue)
        const entityNumber = linkedIssues.length > 0 ? linkedIssues[0] : pr.number
        const entityKind = linkedIssues.length > 0 ? "issue" : "pull_request"
        return {
          key: `${repo}#${entityNumber}`,
          repo,
          number: entityNumber,
          kind: entityKind as "issue" | "pull_request",
          linkedIssues,
        }
      }
    } catch {
      // Fall through to commit message parsing
    }
  }

  // Fallback: parse commit messages for issue references
  const commits = lookup(payload, "commits")
  if (Array.isArray(commits)) {
    const allNums = new Set<number>()
    for (const commit of commits) {
      const msg =
        typeof (commit as Record<string, unknown>)?.message === "string"
          ? ((commit as Record<string, unknown>).message as string)
          : null
      if (msg) {
        for (const num of extractLinkedIssues(msg, repo)) {
          allNums.add(num)
        }
      }
    }
    if (allNums.size > 0) {
      const first = [...allNums][0]
      return {
        key: `${repo}#${first}`,
        repo,
        number: first,
        kind: "issue",
        linkedIssues: [],
      }
    }
  }

  return null
}

// --- Linked issue extraction ---

// Matches: "Fixes #42", "Closes #42", "Resolves #42" (keyword + hash)
const LINKED_KEYWORD_HASH_RE = /(?:fix(?:es)?|close[sd]?|resolve[sd]?)\s+#(\d+)/gi
// Matches: "Fixes https://github.com/owner/repo/issues/42" (keyword + URL)
const LINKED_KEYWORD_URL_RE =
  /(?:fix(?:es)?|close[sd]?|resolve[sd]?)\s+https?:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/gi

/**
 * Extract issue numbers linked from PR bodies and commit messages.
 * Matches "Fixes #N", "Closes #N", "Resolves #N" patterns and their URL variants.
 */
export function extractLinkedIssues(body: string, currentRepo?: string): number[] {
  const nums = new Set<number>()

  // Keyword + #N (same-repo only)
  let m: RegExpExecArray | null
  while ((m = LINKED_KEYWORD_HASH_RE.exec(body)) !== null) {
    nums.add(Number(m[1]))
  }
  LINKED_KEYWORD_HASH_RE.lastIndex = 0

  // Keyword + full URL (filter to same repo if provided)
  while ((m = LINKED_KEYWORD_URL_RE.exec(body)) !== null) {
    const urlRepo = m[1]
    const issueNum = Number(m[2])
    if (!currentRepo || urlRepo === currentRepo) {
      nums.add(issueNum)
    }
  }
  LINKED_KEYWORD_URL_RE.lastIndex = 0

  return [...nums]
}

// --- Payload path lookup utilities ---

/**
 * Walk a dotted path through a payload object.
 * Supports array indexing with [N] syntax.
 */
export function lookup(ctx: unknown, path: string): unknown {
  const parts = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean)
  let cur: unknown = ctx
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in (cur as object)) {
      cur = (cur as Record<string, unknown>)[p]
    } else {
      return undefined
    }
  }
  return cur
}

/** Walk a dotted path and return the value only if it's a string. */
export function lookupString(ctx: unknown, path: string): string | null {
  const v = lookup(ctx, path)
  return typeof v === "string" ? v : null
}

/** Walk a dotted path and return the value only if it's a number. */
export function lookupNumber(ctx: unknown, path: string): number | null {
  const v = lookup(ctx, path)
  return typeof v === "number" ? v : null
}
