import { lookup, lookupString } from "./entity"

export type GitHubInvolvement = {
  author: boolean
  reviewer: boolean
  mentioned: boolean
}

const MENTION_ACTIONS: Record<string, ReadonlySet<string>> = {
  issues: new Set(["opened", "edited"]),
  issue_comment: new Set(["created", "edited"]),
  pull_request: new Set(["opened", "edited"]),
  pull_request_review: new Set(["submitted", "edited"]),
  pull_request_review_comment: new Set(["created", "edited"]),
}

export function shouldAdmitGitHubEvent(opts: {
  event: string
  action: string | null
  hasTriggerLabel: boolean
  involvement: GitHubInvolvement
}): boolean {
  if (opts.hasTriggerLabel || opts.involvement.author) return true

  const requestedReview = opts.event === "pull_request" && opts.action === "review_requested"
  if (opts.involvement.reviewer && requestedReview) return true

  return opts.involvement.mentioned && MENTION_ACTIONS[opts.event]?.has(opts.action ?? "") === true
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function sameLogin(value: string | null, botLogin: string): boolean {
  return !!botLogin && value?.toLowerCase() === botLogin.toLowerCase()
}

function mentionsBot(text: string | null, botLogin: string): boolean {
  if (!text || !botLogin) return false

  const handles = [botLogin, botLogin.replace(/\[bot\]$/i, "")].filter(Boolean)
  return handles.some((handle) => {
    const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    return new RegExp(`(^|[^A-Za-z0-9-])@${escaped}(?![A-Za-z0-9-])`, "i").test(text)
  })
}

/**
 * Extract only the involvement facts that are present in a GitHub webhook.
 * The admission layer uses these facts to decide whether Jared should see an
 * event; the agent still owns the semantic decision to act or skip.
 */
export function deriveGitHubInvolvement(
  _event: string,
  payload: Record<string, unknown>,
  botLogin: string,
): GitHubInvolvement {
  const pr = asRecord(payload.pull_request)
  const issue = asRecord(payload.issue)
  const comment = asRecord(payload.comment)
  const review = asRecord(payload.review)

  const author =
    sameLogin(lookupString(pr ?? {}, "user.login"), botLogin) ||
    sameLogin(lookupString(issue ?? {}, "user.login"), botLogin)

  const reviewerCandidates = [
    lookupString(payload, "requested_reviewer.login"),
    lookupString(pr ?? {}, "requested_reviewer.login"),
    ...((lookup(pr ?? {}, "requested_reviewers") as Array<unknown> | null) ?? []).map((value) =>
      lookupString(asRecord(value) ?? {}, "login"),
    ),
  ]
  const reviewer = reviewerCandidates.some((candidate) => sameLogin(candidate, botLogin))

  const mentioned = [
    lookupString(comment ?? {}, "body"),
    lookupString(review ?? {}, "body"),
    lookupString(issue ?? {}, "body"),
    lookupString(pr ?? {}, "body"),
  ].some((text) => mentionsBot(text, botLogin))

  return { author, reviewer, mentioned }
}
