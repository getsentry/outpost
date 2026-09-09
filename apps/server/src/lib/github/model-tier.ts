// Classify a webhook event into a model tier for the primary Jared agent.
//
// The primary agent is the router: it reads the event, picks a situation skill,
// and does the work. GitHub conversation events need the same judgment and
// continuity as a dashboard conversation, so they use the heavy model. Only a
// successful terminal CI event stays on the cheaper mechanical path.
//
// The Worker computes this and embeds it in the event prompt (formatEventPrompt);
// the agent reads it back via modelForDelivery(). Default is "heavy" so a
// misclassification can never silently downgrade real code work.

import { lookupString } from "./entity"

export type ModelTier = "light" | "heavy"

// A model may need the heavy tier to investigate or plan, but only a request
// that calls for a concrete repository/GitHub action belongs in the durable
// completion ledger. Otherwise a one-turn answer would be resurrected as a
// stale unfinished task on the next delivery.
const DURABLE_EXECUTION_REQUEST =
  /\b(?:fix|implement|change|update|refactor|resolve|resume|continue|review|take control|commit|push|ship|merge)\b/i

export function isDurableExecutionRequest(text: string): boolean {
  return DURABLE_EXECUTION_REQUEST.test(text)
}

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
