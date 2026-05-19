// Extract the GitHub entity key from a webhook payload. The entity key
// is the natural "thing being worked on": owner/repo#N where N is the
// issue or PR number. All events related to the same issue or PR share
// the same entity key, enabling session affinity.
//
// Also extracts linked issue numbers from PR bodies so the lifecycle
// store can link issue->PR for session reuse.

import type { EntityResolver } from "./entity-resolver"
import type { GitHubFetcher } from "./github-api"
import { lookup, lookupString } from "./template"

export type EntityKey = {
  // Canonical key: "owner/repo#123". Used as the session affinity key.
  key: string
  repo: string
  number: number
  kind: "issue" | "pull_request"
  // Issue numbers referenced by "Fixes #N" / "Closes #N" in a PR body.
  linkedIssues: number[]
}

// Extract entity key from a GitHub webhook payload or email event.
// Returns null for events that don't map to a trackable entity.
// Email events use the AI entity resolver to identify the GitHub
// entity from any email source (GitHub, Sentry, CI, etc.).
// When a GitHubFetcher is provided, events that lack full context
// (check_suite, workflow_run, push) will make API calls to enrich
// the entity with linked issues.
export async function extractEntityKey(
  event: string,
  payload: unknown,
  resolver?: EntityResolver | null,
  fetcher?: GitHubFetcher | null,
): Promise<EntityKey | null> {
  if (event.startsWith("email.")) {
    return resolveEmailEntity(payload, resolver)
  }

  const repo = lookupString(payload, "repository.full_name")
  if (!repo) return null

  // issue_comment uses payload.issue (which may be a PR)
  if (event === "issue_comment") {
    const num = lookup(payload, "issue.number")
    if (typeof num !== "number") return null
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
    const num = lookup(payload, "issue.number")
    if (typeof num !== "number") return null
    return { key: `${repo}#${num}`, repo, number: num, kind: "issue", linkedIssues: [] }
  }

  // pull_request.*
  if (event === "pull_request") {
    const num = lookup(payload, "pull_request.number")
    if (typeof num !== "number") return null
    const body = lookupString(payload, "pull_request.body") ?? ""
    return {
      key: `${repo}#${num}`,
      repo,
      number: num,
      kind: "pull_request",
      linkedIssues: extractLinkedIssues(body, repo),
    }
  }

  // pull_request_review_comment.*
  if (event === "pull_request_review_comment") {
    const num = lookup(payload, "pull_request.number")
    if (typeof num !== "number") return null
    const body = lookupString(payload, "pull_request.body") ?? ""
    return {
      key: `${repo}#${num}`,
      repo,
      number: num,
      kind: "pull_request",
      linkedIssues: extractLinkedIssues(body, repo),
    }
  }

  // pull_request_review.*
  if (event === "pull_request_review") {
    const num = lookup(payload, "pull_request.number")
    if (typeof num !== "number") return null
    const body = lookupString(payload, "pull_request.body") ?? ""
    return {
      key: `${repo}#${num}`,
      repo,
      number: num,
      kind: "pull_request",
      linkedIssues: extractLinkedIssues(body, repo),
    }
  }

  // check_suite.* -- extract from pull_requests array, fetch PR body for links
  if (event === "check_suite") {
    const prs = lookup(payload, "check_suite.pull_requests")
    if (!Array.isArray(prs) || prs.length === 0) return null
    const first = prs[0] as Record<string, unknown>
    const num = first?.number
    if (typeof num !== "number") return null
    const linkedIssues = fetcher ? await fetchLinkedIssues(fetcher, repo, num) : []
    return { key: `${repo}#${num}`, repo, number: num, kind: "pull_request", linkedIssues }
  }

  // workflow_run.* -- extract from pull_requests array, fetch PR body for links
  if (event === "workflow_run") {
    const prs = lookup(payload, "workflow_run.pull_requests")
    if (!Array.isArray(prs) || prs.length === 0) return null
    const first = prs[0] as Record<string, unknown>
    const num = first?.number
    if (typeof num !== "number") return null
    const linkedIssues = fetcher ? await fetchLinkedIssues(fetcher, repo, num) : []
    return { key: `${repo}#${num}`, repo, number: num, kind: "pull_request", linkedIssues }
  }

  // push -- resolve branch to PR, or parse commit messages for issue refs
  if (event === "push") {
    return resolvePushEntity(payload, repo, fetcher)
  }

  return null
}

// Fetch a PR's body via GitHub API and extract linked issues from it.
async function fetchLinkedIssues(fetcher: GitHubFetcher, repo: string, prNumber: number): Promise<number[]> {
  const pr = await fetcher.fetchPR(repo, prNumber)
  if (!pr?.body) return []
  return extractLinkedIssues(pr.body, repo)
}

// Resolve a push event to an entity by:
//   1. Looking up the open PR for the pushed branch
//   2. Falling back to parsing commit messages for "Fixes #N" refs
async function resolvePushEntity(
  payload: unknown,
  repo: string,
  fetcher?: GitHubFetcher | null,
): Promise<EntityKey | null> {
  const ref = lookupString(payload, "ref")

  // Try to find the PR for this branch via API
  if (fetcher && ref?.startsWith("refs/heads/")) {
    const branch = ref.slice("refs/heads/".length)
    const pr = await fetcher.findPRForBranch(repo, branch)
    if (pr) {
      const linkedIssues = pr.body ? extractLinkedIssues(pr.body, repo) : []
      return { key: `${repo}#${pr.number}`, repo, number: pr.number, kind: "pull_request", linkedIssues }
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
      return { key: `${repo}#${first}`, repo, number: first, kind: "issue", linkedIssues: [] }
    }
  }

  return null
}

// Resolve email entity key using the AI resolver, then verify via gh CLI.
async function resolveEmailEntity(payload: unknown, resolver?: EntityResolver | null): Promise<EntityKey | null> {
  if (!resolver) return null
  const o = payload as Record<string, unknown> | null
  if (!o || typeof o !== "object") return null

  const bodyText = typeof o.body_text === "string" ? o.body_text : null

  const result = await resolver.resolve({
    from: typeof o.from === "string" ? o.from : "",
    to: typeof o.to === "string" ? o.to : "",
    subject: typeof o.subject === "string" ? o.subject : "",
    message_id: typeof o.message_id === "string" ? o.message_id : "",
    in_reply_to: typeof o.in_reply_to === "string" ? o.in_reply_to : null,
    references: Array.isArray(o.references) ? o.references.filter((s): s is string => typeof s === "string") : [],
    list_id: typeof o.list_id === "string" ? o.list_id : null,
    x_github_reason: typeof o.x_github_reason === "string" ? o.x_github_reason : null,
    x_github_sender: typeof o.x_github_sender === "string" ? o.x_github_sender : null,
    body_text: bodyText,
  })

  if (!result.entity || result.confidence === "low") return null

  const verified = await resolver.verify(result.entity)
  if (!verified) {
    const linkedIssues =
      result.entity.kind === "pull_request" && bodyText ? extractLinkedIssues(bodyText, result.entity.repo) : []
    return {
      key: `${result.entity.repo}#${result.entity.number}`,
      repo: result.entity.repo,
      number: result.entity.number,
      kind: result.entity.kind,
      linkedIssues,
    }
  }

  const linkedIssues =
    verified.kind === "pull_request" && verified.body ? extractLinkedIssues(verified.body, verified.repo) : []

  return {
    key: `${verified.repo}#${verified.number}`,
    repo: verified.repo,
    number: verified.number,
    kind: verified.kind,
    linkedIssues,
  }
}

// Extract issue numbers from PR bodies and commit messages.
// Matches:
//   - "Fixes #42", "Closes #42", "Resolves #42" (keyword + hash)
//   - "Fixes https://github.com/owner/repo/issues/42" (keyword + URL)
const LINKED_KEYWORD_HASH_RE = /(?:fix(?:es)?|close[sd]?|resolve[sd]?)\s+#(\d+)/gi
const LINKED_KEYWORD_URL_RE =
  /(?:fix(?:es)?|close[sd]?|resolve[sd]?)\s+https?:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/gi

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

// Parse an entity key string like "owner/repo#123" into an EntityKey.
const ENTITY_KEY_RE = /^([^/]+\/[^#]+)#(\d+)$/

export function parseEntityKey(keyStr: string): EntityKey | null {
  const match = keyStr.match(ENTITY_KEY_RE)
  if (!match) return null
  const repo = match[1]
  const number = Number.parseInt(match[2], 10)
  if (!Number.isFinite(number)) return null
  return {
    key: keyStr,
    repo,
    number,
    kind: "issue",
    linkedIssues: [],
  }
}
