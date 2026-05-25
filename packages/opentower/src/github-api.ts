// Lightweight GitHub API client for entity enrichment.
// Used to fetch PR bodies, resolve branches to PRs, etc.
// Works with either a GitHub App installation token or a GH_TOKEN PAT.

import * as Sentry from "@sentry/bun"
import { formatError } from "./logger"

const GITHUB_API = "https://api.github.com"

export type GitHubFetcher = {
  fetchPR(repo: string, number: number): Promise<{ body: string | null } | null>
  fetchIssue(repo: string, number: number): Promise<{ body: string | null } | null>
  fetchEntity(repo: string, number: number): Promise<{ kind: "issue" | "pull_request"; body: string | null } | null>
  findPRForBranch(repo: string, branch: string): Promise<{ number: number; body: string | null } | null>
}

export function createGitHubFetcher(token: string): GitHubFetcher {
  const headers = {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  }

  // Shared fetch helper for PR and issue endpoints. Avoids duplicating
  // the try/catch + Sentry logging pattern across fetchPR and fetchIssue.
  async function fetchByType(
    type: "pulls" | "issues",
    repo: string,
    number: number,
  ): Promise<{ body: string | null } | null> {
    try {
      const res = await fetch(`${GITHUB_API}/repos/${repo}/${type}/${number}`, { headers })
      if (!res.ok) return null
      const data = (await res.json()) as { body: string | null }
      return { body: data.body }
    } catch (err) {
      Sentry.logger.warn(`github_api.fetch_${type === "pulls" ? "pr" : "issue"}_failed`, {
        repo,
        number,
        error: formatError(err),
      })
      return null
    }
  }

  async function fetchPR(repo: string, number: number) {
    return fetchByType("pulls", repo, number)
  }

  async function fetchIssue(repo: string, number: number) {
    return fetchByType("issues", repo, number)
  }

  async function fetchEntity(repo: string, number: number) {
    // Try PR first — issues API also returns PRs but with less detail
    const pr = await fetchPR(repo, number)
    if (pr) return { kind: "pull_request" as const, body: pr.body }
    const issue = await fetchIssue(repo, number)
    if (issue) return { kind: "issue" as const, body: issue.body }
    return null
  }

  async function findPRForBranch(repo: string, branch: string) {
    try {
      const [owner] = repo.split("/")
      const res = await fetch(
        `${GITHUB_API}/repos/${repo}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=open&per_page=1`,
        { headers },
      )
      if (!res.ok) return null
      const data = (await res.json()) as Array<{ number: number; body: string | null }>
      if (data.length === 0) return null
      return { number: data[0].number, body: data[0].body }
    } catch (err) {
      Sentry.logger.warn("github_api.find_pr_failed", {
        repo,
        branch,
        error: formatError(err),
      })
      return null
    }
  }

  return { fetchPR, fetchIssue, fetchEntity, findPRForBranch }
}
