// Formats a webhook event as a markdown prompt for the OpenCode agent.
//
// The output matches the structure expected by the jared agent:
// event type header, bot identity, repo context, and the full payload.

const REVIEW_EVENTS = new Set(["pull_request_review", "pull_request_review_comment", "pull_request_review_thread"])

/**
 * Build a review-specific guidance block for PR review events. Surfaces the IDs
 * the agent needs to reply inline and resolve the thread (instead of posting a
 * top-level comment), and spells out the expected workflow. Returns "" for
 * non-review events.
 */
function reviewGuidance(event: string, payload: string): string {
  if (!REVIEW_EVENTS.has(event)) return ""

  let data: Record<string, unknown> = {}
  try {
    data = JSON.parse(payload) as Record<string, unknown>
  } catch {
    /* fall back to guidance without ids */
  }

  const pr = (data.pull_request as Record<string, unknown> | undefined) ?? undefined
  const comment = (data.comment as Record<string, unknown> | undefined) ?? undefined
  const review = (data.review as Record<string, unknown> | undefined) ?? undefined
  const thread = (data.thread as Record<string, unknown> | undefined) ?? undefined

  const ids: string[] = []
  if (typeof pr?.number === "number") ids.push(`- PR number: ${pr.number}`)
  if (typeof review?.id === "number") ids.push(`- Review id: ${review.id}`)
  if (typeof comment?.id === "number") {
    const inReplyTo = typeof comment.in_reply_to_id === "number" ? ` (in reply to ${comment.in_reply_to_id})` : ""
    ids.push(`- Inline comment id: ${comment.id}${inReplyTo} — reply via the replies endpoint, not \`gh pr comment\``)
  }
  if (typeof comment?.path === "string") ids.push(`- File: ${comment.path}`)
  if (typeof thread?.node_id === "string") ids.push(`- Thread node id: ${thread.node_id}`)

  const idBlock = ids.length > 0 ? `${ids.join("\n")}\n` : ""

  return `

This is a PR review event. Respond to the review threads — do NOT post a top-level PR comment.
${idBlock}
Workflow:
- Reply inline on the specific review thread (REST \`pulls/<n>/comments/<comment_id>/replies\`), never \`gh pr comment\`.
- If a thread is actionable, push a fix, reply on that thread with the commit SHA, then resolve the thread
  (GraphQL \`resolveReviewThread\`). Only resolve threads you actually fixed; leave won't-fix threads open with a reason.
- After applying fixes, re-request review from the reviewer.
See the \`respond-to-comment\` skill for the exact commands.`
}

export function formatEventPrompt(opts: {
  event: string
  action: string | null
  deliveryId: string
  sender: string | null
  repo: string | null
  entityKey: string
  payload: string
  botLogin: string
}): string {
  const eventLabel = opts.action ? `${opts.event}.${opts.action}` : opts.event

  return `New webhook event: ${eventLabel}

Bot identity: ${opts.botLogin}
Repository: ${opts.repo ?? "unknown"}
Entity: ${opts.entityKey}
Sender: ${opts.sender ?? "unknown"}
Delivery: ${opts.deliveryId}
${reviewGuidance(opts.event, opts.payload)}
Payload:
\`\`\`json
${opts.payload}
\`\`\``
}
