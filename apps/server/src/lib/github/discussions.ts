import { lookup, lookupString } from "./entity"

export const DISCUSSION_OUTCOMES = ["addressed", "explained", "needs-human"] as const

export type DiscussionOutcome = (typeof DISCUSSION_OUTCOMES)[number]
export type DiscussionKind = "top_level" | "inline" | "review"

export type DiscussionObligation = {
  kind: DiscussionKind
  prNumber: number
  sourceCommentId: string
  replyToCommentId: string | null
  author: string
  body: string
  url: string | null
  createdAt: string | null
}

export type DiscussionResponseMarker = {
  obligationId: string
  outcome: DiscussionOutcome
}

export type DiscussionResponseEvidence = DiscussionResponseMarker & {
  prNumber: number
  /** For an inline reply GitHub gives us the comment it directly answers. */
  replyToCommentId: string | null
}

export type OpenDiscussionObligation = Pick<
  DiscussionObligation,
  "kind" | "sourceCommentId" | "replyToCommentId" | "author" | "body" | "url"
> & { id: string }

export type DiscussionSourceReference = Pick<DiscussionObligation, "kind" | "sourceCommentId">

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asId(value: unknown): string | null {
  return typeof value === "number" || typeof value === "string" ? String(value) : null
}

function sameLogin(a: string | null, b: string): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase()
}

function extractComment(value: unknown): {
  id: string
  replyToCommentId: string | null
  author: string
  authorType: string | null
  body: string
  url: string | null
  createdAt: string | null
} | null {
  const comment = asRecord(value)
  if (!comment) return null

  const id = asId(comment.id)
  const author = lookupString(comment, "user.login")
  const body = lookupString(comment, "body")?.trim()
  if (!id || !author || !body) return null

  return {
    id,
    replyToCommentId: asId(comment.in_reply_to_id),
    author,
    authorType: lookupString(comment, "user.type"),
    body,
    url: lookupString(comment, "html_url"),
    createdAt: lookupString(comment, "created_at"),
  }
}

function prNumberFor(event: string, payload: Record<string, unknown>): number | null {
  const entity = event === "issue_comment" ? asRecord(payload.issue) : asRecord(payload.pull_request)
  return typeof entity?.number === "number" ? entity.number : null
}

/** Return the PR currently being acted on, even when its session is issue-keyed. */
export function extractDiscussionPrNumber(event: string, payload: Record<string, unknown>): number | null {
  const direct = prNumberFor(event, payload)
  if (direct !== null) return direct

  if (event === "check_suite" || event === "workflow_run") {
    const run = asRecord(payload[event])
    const pullRequests = lookup(run ?? {}, "pull_requests")
    if (Array.isArray(pullRequests) && typeof asRecord(pullRequests[0])?.number === "number") {
      return asRecord(pullRequests[0])?.number as number
    }
  }

  return null
}

/**
 * Convert a GitHub discussion webhook into a durable reply obligation.
 *
 * Top-level integration chatter is intentionally excluded. Inline bot reviews
 * remain in scope: automated reviewers often raise real, actionable feedback.
 */
export function extractDiscussionObligation(
  event: string,
  action: string | null,
  payload: Record<string, unknown>,
  botLogin: string,
): DiscussionObligation | null {
  const isTopLevel = event === "issue_comment"
  const isInline = event === "pull_request_review_comment"
  const isReview = event === "pull_request_review"
  if (!isTopLevel && !isInline && !isReview) return null
  const actionable = isReview
    ? action === "submitted" || action === "edited"
    : action === "created" || action === "edited"
  if (!actionable) return null

  if (isTopLevel && lookup(payload, "issue.pull_request") == null) return null

  const prNumber = prNumberFor(event, payload)
  const source = extractComment(isReview ? payload.review : payload.comment)
  if (!prNumber || !source || sameLogin(source.author, botLogin)) return null
  if (isTopLevel && source.authorType?.toLowerCase() === "bot") return null

  return {
    kind: isTopLevel ? "top_level" : isInline ? "inline" : "review",
    prNumber,
    sourceCommentId: source.id,
    replyToCommentId: source.replyToCommentId,
    author: source.author,
    body: source.body,
    url: source.url,
    createdAt: source.createdAt,
  }
}

/** Identify a discussion row even when GitHub is telling us it was removed. */
export function extractDiscussionSourceReference(
  event: string,
  payload: Record<string, unknown>,
): DiscussionSourceReference | null {
  const kind =
    event === "issue_comment"
      ? "top_level"
      : event === "pull_request_review_comment"
        ? "inline"
        : event === "pull_request_review"
          ? "review"
          : null
  if (!kind) return null
  const source = asRecord(kind === "review" ? payload.review : payload.comment)
  const sourceCommentId = asId(source?.id)
  return sourceCommentId ? { kind, sourceCommentId } : null
}

export function discussionResponseMarker(obligationId: string, outcome: DiscussionOutcome): string {
  return `<!-- jared-discussion:${obligationId}:${outcome} -->`
}

/**
 * A durable inbox rendered into each admitted turn. The outcome is intentionally
 * chosen by Jared after inspecting the live PR; the ledger only guarantees that
 * every message gets a direct, attributable response.
 */
export function formatDiscussionInbox(obligations: OpenDiscussionObligation[]): string {
  if (obligations.length === 0) return ""

  const items = obligations
    .map(
      (obligation, index) => `### ${index + 1}. ${obligation.kind.replace("_", " ")} from ${obligation.author}
${obligation.url ? `${obligation.url}\n` : ""}
${
  obligation.kind === "inline"
    ? `Reply in this review thread via top-level comment ID: ${obligation.replyToCommentId ?? obligation.sourceCommentId} (the message above is comment ID: ${obligation.sourceCommentId})\n`
    : ""
}
${obligation.body}

After your substantive reply, append \`<!-- jared-discussion:${obligation.id}:<outcome> -->\`, where \`<outcome>\` is \`addressed\`, \`explained\`, or \`needs-human\`.`,
    )
    .join("\n\n")

  return `

## PR discussion inbox — ${obligations.length} open discussion obligations

Before you finish this turn, inspect the current PR and respond to every item below in its correct GitHub channel. Think through the request and give the reviewer a direct answer; do not send a generic acknowledgement, a status-only message, or a fixed template. You may fix code, explain a considered decision, or ask the one specific human decision that is genuinely required. Resolve an inline thread only after an actual fix; a thoughtful explanation or question leaves it open.

${items}`
}

export function parseDiscussionResponseMarker(body: string): DiscussionResponseMarker | null {
  const match = /<!--\s*jared-discussion:([A-Za-z0-9_-]+):(addressed|explained|needs-human)\s*-->/.exec(body)
  if (!match) return null
  return { obligationId: match[1]!, outcome: match[2]! as DiscussionOutcome }
}

/**
 * A signed webhook for Jared's own reply is the immediate completion receipt.
 * Do not trust a copied marker authored by a reviewer or another integration.
 */
export function responseEvidenceFromWebhook(
  event: string,
  payload: Record<string, unknown>,
  sender: string | null,
  botLogin: string,
): DiscussionResponseEvidence | null {
  if (!sameLogin(sender, botLogin)) return null
  if (event !== "issue_comment" && event !== "pull_request_review_comment" && event !== "pull_request_review")
    return null

  const source = event === "pull_request_review" ? asRecord(payload.review) : asRecord(payload.comment)
  const body = lookupString(source ?? {}, "body") ?? ""
  const marker = parseDiscussionResponseMarker(body)
  const prNumber = extractDiscussionPrNumber(event, payload)
  // A marker is a receipt, not the reply itself. Requiring text outside it
  // stops a broken agent from clearing the inbox without talking to anyone.
  const visibleBody = body
    .replace(/<!--\s*jared-discussion:[A-Za-z0-9_-]+:(?:addressed|explained|needs-human)\s*-->/g, "")
    .trim()
  if (!marker || !prNumber || !visibleBody) return null

  return {
    ...marker,
    prNumber,
    replyToCommentId: asId(source?.in_reply_to_id),
  }
}

/** A receipt must belong to the same PR and, for review threads, reply to its root. */
export function responseMatchesDiscussion(
  obligation: Pick<DiscussionObligation, "kind" | "prNumber" | "sourceCommentId" | "replyToCommentId">,
  response: DiscussionResponseEvidence,
): boolean {
  if (obligation.prNumber !== response.prNumber) return false
  const threadRoot = obligation.replyToCommentId ?? obligation.sourceCommentId
  return obligation.kind !== "inline" || response.replyToCommentId === threadRoot
}
