// Lightweight GitHub API client for entity enrichment.
// Used to fetch PR bodies, resolve branches to PRs, etc.
// Works with either a GitHub App installation token or a GH_TOKEN PAT.

import * as Sentry from "@sentry/bun"

const GITHUB_API = "https://api.github.com"

export type GitHubFetcher = {
  fetchPR(repo: string, number: number): Promise<{ body: string | null } | null>
  findPRForBranch(repo: string, branch: string): Promise<{ number: number; body: string | null } | null>
}

export function createGitHubFetcher(token: string): GitHubFetcher {
  const headers = {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  }

  return {
    async fetchPR(repo, number) {
      try {
        const res = await fetch(`${GITHUB_API}/repos/${repo}/pulls/${number}`, { headers })
        if (!res.ok) return null
        const data = (await res.json()) as { body: string | null }
        return { body: data.body }
      } catch (err) {
        Sentry.logger.warn("github_api.fetch_pr_failed", {
          repo,
          number,
          error: err instanceof Error ? err.message : String(err),
        })
        return null
      }
    },

    async findPRForBranch(repo, branch) {
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
          error: err instanceof Error ? err.message : String(err),
        })
        return null
      }
    },
  }
}
