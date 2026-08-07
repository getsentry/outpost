// Immediate emoji acknowledgment for user-facing GitHub events.
//
// When a human triggers Jared — labels an issue, comments on a PR/issue, or
// leaves a review comment — we drop an 👀 "eyes" reaction on the exact thing
// they touched, synchronously at webhook time and independent of the agent
// actually booting a sandbox. It's the cheap "seen it, on it" signal a teammate
// gives, and it lands in seconds even when the real run takes a minute to warm
// up. Best-effort: a failed reaction never blocks dispatch.
//
// The matching "done" signal (🎉) is left by the agent itself once it has
// finished the work (see the "Signaling progress" section of the instructions),
// because only the agent knows when the review/fix/PR is actually complete.

import { formatError } from "@jared/utils"
import type { GitHubApp } from "./app"
import { lookup } from "./entity"

type AckTarget =
  | { kind: "issue"; number: number }
  | { kind: "issueComment"; id: number }
  | { kind: "reviewComment"; id: number }

function toNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

/**
 * The thing to react on for a given event, or null when the event has no
 * natural "you asked, I'm looking" target (CI runs, pushes, edits, deletions).
 */
export function ackTarget(event: string, action: string | null, payload: Record<string, unknown>): AckTarget | null {
  if (event === "issue_comment" && action === "created") {
    const id = toNumber(lookup(payload, "comment.id"))
    return id ? { kind: "issueComment", id } : null
  }
  if (event === "pull_request_review_comment" && action === "created") {
    const id = toNumber(lookup(payload, "comment.id"))
    return id ? { kind: "reviewComment", id } : null
  }
  if (event === "issues" && (action === "labeled" || action === "opened" || action === "reopened")) {
    const number = toNumber(lookup(payload, "issue.number"))
    return number ? { kind: "issue", number } : null
  }
  if (event === "pull_request_review" && action === "submitted") {
    const number = toNumber(lookup(payload, "pull_request.number"))
    return number ? { kind: "issue", number } : null
  }
  return null
}

/**
 * Drop an 👀 reaction on the triggering comment/issue so the human sees Jared
 * picked the event up right away. Never throws — a reaction is a nicety, not a
 * gate on dispatch.
 */
export async function acknowledgeGitHubEvent(opts: {
  app: GitHubApp
  installationId: number | null
  repo: string | null
  event: string
  action: string | null
  payload: Record<string, unknown>
  logger?: { warn: (obj: unknown, msg: string) => void }
}): Promise<void> {
  const { app, installationId, repo, event, action, payload, logger } = opts
  if (!installationId || !repo) return
  const [owner, name] = repo.split("/")
  if (!owner || !name) return

  const target = ackTarget(event, action, payload)
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
