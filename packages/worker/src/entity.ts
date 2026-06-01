// Extract the GitHub entity key from a webhook payload. The entity key
// is the natural "thing being worked on": owner/repo#N where N is the
// issue or PR number. All events related to the same entity share the
// same key, enabling session affinity via Cloudflare Container routing.

import type { GitHubFetcher } from "./github-api"
import { lookup, lookupString } from "./template"

export type EntityKey = {
  key: string
  repo: string
  number: number
  kind: "issue" | "pull_request"
  linkedIssues: number[]
}

const PR_EVENTS = new Set(["pull_request", "pull_request_review_comment", "pull_request_review"])

const CI_EVENTS: Record<string, string> = {
  check_suite: "check_suite.pull_requests",
  workflow_run: "workflow_run.pull_requests",
}

export async function extractEntityKey(
  event: string,
  payload: unknown,
  fetcher?: GitHubFetcher | null,
): Promise<EntityKey | null> {
  const repo = lookupString(payload, "repository.full_name")
  if (!repo) return null

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

  if (event === "issues") {
    const num = lookup(payload, "issue.number")
    if (typeof num !== "number") return null
    return { key: `${repo}#${num}`, repo, number: num, kind: "issue", linkedIssues: [] }
  }

  if (PR_EVENTS.has(event)) {
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

  const ciPath = CI_EVENTS[event]
  if (ciPath) {
    const prs = lookup(payload, ciPath)
    if (!Array.isArray(prs) || prs.length === 0) return null
    const first = prs[0] as Record<string, unknown>
    const num = first?.number
    if (typeof num !== "number") return null
    const linkedIssues = fetcher ? await fetchLinkedIssues(fetcher, repo, num) : []
    return { key: `${repo}#${num}`, repo, number: num, kind: "pull_request", linkedIssues }
  }

  if (event === "push") {
    return resolvePushEntity(payload, repo, fetcher)
  }

  return null
}

async function fetchLinkedIssues(fetcher: GitHubFetcher, repo: string, prNumber: number): Promise<number[]> {
  const pr = await fetcher.fetchPR(repo, prNumber)
  if (!pr?.body) return []
  return extractLinkedIssues(pr.body, repo)
}

async function resolvePushEntity(
  payload: unknown,
  repo: string,
  fetcher?: GitHubFetcher | null,
): Promise<EntityKey | null> {
  const ref = lookupString(payload, "ref")

  if (fetcher && ref?.startsWith("refs/heads/")) {
    const branch = ref.slice("refs/heads/".length)
    const pr = await fetcher.findPRForBranch(repo, branch)
    if (pr) {
      const linkedIssues = pr.body ? extractLinkedIssues(pr.body, repo) : []
      return { key: `${repo}#${pr.number}`, repo, number: pr.number, kind: "pull_request", linkedIssues }
    }
  }

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

const LINKED_KEYWORD_HASH_RE = /(?:fix(?:es)?|close[sd]?|resolve[sd]?)\s+#(\d+)/gi
const LINKED_KEYWORD_URL_RE =
  /(?:fix(?:es)?|close[sd]?|resolve[sd]?)\s+https?:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/gi

export function extractLinkedIssues(body: string, currentRepo?: string): number[] {
  const nums = new Set<number>()

  let m: RegExpExecArray | null
  while ((m = LINKED_KEYWORD_HASH_RE.exec(body)) !== null) {
    nums.add(Number(m[1]))
  }
  LINKED_KEYWORD_HASH_RE.lastIndex = 0

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
