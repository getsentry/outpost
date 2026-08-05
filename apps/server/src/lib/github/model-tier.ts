// Classify a webhook event into a model tier for the primary Jared agent.
//
// The primary agent is the router: it reads the event, picks a situation skill,
// and does the work. Situations that produce code (resolve-issue, fix-ci,
// review-pr) get the heavy model; lightweight situations (respond-to-comment,
// approvals, mark-pr-ready) get a cheaper balanced-cost model. This mirrors the
// routing table in the agent instructions so the model matches the skill.
//
// The Worker computes this and embeds it in the event prompt (formatEventPrompt);
// the agent reads it back via modelForDelivery(). Default is "heavy" so a
// misclassification can never silently downgrade real code work.

import { lookup, lookupString } from "./entity"

export type ModelTier = "light" | "heavy"

const REVIEW_EVENTS = new Set(["pull_request_review", "pull_request_review_comment", "pull_request_review_thread"])

/**
 * Decide the primary model tier for a webhook event.
 *
 * `payload` is the raw webhook JSON string (as stored / dispatched).
 */
export function classifyModelTier(event: string, _action: string | null, payload: string): ModelTier {
  let data: Record<string, unknown> = {}
  try {
    data = JSON.parse(payload) as Record<string, unknown>
  } catch {
    return "heavy"
  }

  // Review activity → respond-to-comment. Light.
  if (REVIEW_EVENTS.has(event)) return "light"

  // Comment on a PR → respond-to-comment (light). Comment on an issue →
  // resolve-issue (heavy). PRs carry issue.pull_request in the payload.
  if (event === "issue_comment") {
    return lookup(data, "issue.pull_request") != null ? "light" : "heavy"
  }

  // CI results: success → mark-pr-ready (light, mechanical); failure → fix-ci
  // (heavy). Anything else is skipped anyway — default heavy is harmless.
  if (event === "check_suite" || event === "workflow_run") {
    const conclusion = lookupString(data, `${event}.conclusion`)
    return conclusion === "success" ? "light" : "heavy"
  }

  // issues.* (resolve-issue), pull_request opened/assigned (review-pr), and
  // everything else → heavy.
  return "heavy"
}
