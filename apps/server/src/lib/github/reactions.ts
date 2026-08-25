// Best-effort GitHub reactions used to signal that Jared has accepted work.

import { formatError } from "@jared/utils"
import type { GitHubApp } from "./app"
import { lookup, lookupString } from "./entity"

type AckTarget =
  | { kind: "issue"; number: number }
  | { kind: "issueComment"; id: number }
  | { kind: "reviewComment"; id: number }

function toNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function isDirectedAtAnotherUser(body: string | null, botLogin: string): boolean {
  if (!body || !botLogin) return false

  const mentions = [...body.matchAll(/(^|[^\w-])@([\w-]+(?:\[bot\])?)/g)].map((match) => match[2].toLowerCase())
  return mentions.length > 0 && !mentions.includes(botLogin.toLowerCase())
}

/**
 * Return a safe acknowledgement target for an event Jared will act on.
 *
 * This intentionally mirrors the router's most visible skip cases. A reaction
 * means "Jared is on it", so avoid posting one for approval-only reviews or
 * PR comments explicitly addressed to another user.
 */
export function ackTarget(
  event: string,
  action: string | null,
  payload: Record<string, unknown>,
  botLogin: string,
): AckTarget | null {
  if (event === "issue_comment" && action === "created") {
    const isPrComment = lookup(payload, "issue.pull_request") != null
    if (isPrComment && isDirectedAtAnotherUser(lookupString(payload, "comment.body"), botLogin)) return null

    const id = toNumber(lookup(payload, "comment.id"))
    return id ? { kind: "issueComment", id } : null
  }

  if (event === "pull_request_review_comment" && action === "created") {
    if (isDirectedAtAnotherUser(lookupString(payload, "comment.body"), botLogin)) return null

    const id = toNumber(lookup(payload, "comment.id"))
    return id ? { kind: "reviewComment", id } : null
  }

  if (event === "issues" && action === "labeled") {
    const number = toNumber(lookup(payload, "issue.number"))
    return number ? { kind: "issue", number } : null
  }

  if (event === "pull_request_review" && action === "submitted") {
    if (lookupString(payload, "review.state") === "approved") return null

    const number = toNumber(lookup(payload, "pull_request.number"))
    return number ? { kind: "issue", number } : null
  }

  return null
}

/** Drop an 👀 reaction without allowing a reaction failure to block dispatch. */
export async function acknowledgeGitHubEvent(opts: {
  app: GitHubApp
  installationId: number | null
  repo: string | null
  event: string
  action: string | null
  payload: Record<string, unknown>
  botLogin: string
  logger?: { warn: (obj: unknown, msg: string) => void }
}): Promise<void> {
  const { app, installationId, repo, event, action, payload, botLogin, logger } = opts
  if (!installationId || !repo) return

  const [owner, name] = repo.split("/")
  if (!owner || !name) return

  const target = ackTarget(event, action, payload, botLogin)
  if (!target) return

  try {
    const octokit = app.getInstallationOctokit(installationId)
    if (target.kind === "issue") {
      await octokit.reactions.createForIssue({ owner, repo: name, issue_number: target.number, content: "eyes" })
    } else if (target.kind === "issueComment") {
      await octokit.reactions.createForIssueComment({ owner, repo: name, comment_id: target.id, content: "eyes" })
    } else {
      await octokit.reactions.createForPullRequestReviewComment({
        owner,
        repo: name,
        comment_id: target.id,
        content: "eyes",
      })
    }
  } catch (err) {
    logger?.warn({ error: formatError(err) }, "ack reaction failed")
  }
}
