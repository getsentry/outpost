// Server-side actionability gate for noisy CI webhook deliveries.
//
// A single PR generates a firehose of `workflow_run` and `check_suite` events:
// `requested` → `in_progress` → `completed` for every workflow, times every
// push. In one observed run (getsentry/craft#864) ~140 of 173 conversation
// turns were CI lifecycle events, each waking the agent only for it to reply
// `SKIPPED` — while permanently bloating the conversation context.
//
// Jared's own triage already discards these (skip condition #6: skip a
// check_suite/workflow_run unless it is `completed`, concluded `failure`/
// `success`, and attached to a PR). Applying that *same* rule here, before
// dispatch, changes nothing about which events the agent acts on — it just
// stops us from waking the agent (and growing the transcript) for events it
// would immediately skip.

import { lookup, lookupString } from "./entity"

/** GitHub Actions conclusions Jared actually routes on (fix-ci / mark-pr-ready). */
const ACTIONABLE_CONCLUSIONS = new Set(["failure", "success"])

export type CiActionability =
  | { actionable: true; conclusion: "failure" | "success" }
  | { actionable: false; reason: "ci_incomplete" | "ci_not_actionable" | "ci_no_pr" }

/** Whether an event is one of the noisy CI lifecycle types this gate governs. */
export function isCiEvent(event: string): boolean {
  return event === "check_suite" || event === "workflow_run"
}

/**
 * Decide whether a `check_suite` / `workflow_run` delivery is worth dispatching.
 * Mirrors Jared's triage skip-condition #6 exactly, so routing is unchanged.
 *
 * Caller must only invoke this for CI events (see {@link isCiEvent}).
 */
export function classifyCiEvent(
  event: string,
  action: string | null,
  payload: Record<string, unknown>,
): CiActionability {
  if (action !== "completed") return { actionable: false, reason: "ci_incomplete" }

  const ciObj = lookup(payload, event) as Record<string, unknown> | null
  const conclusion = lookupString(ciObj ?? {}, "conclusion")
  if (!conclusion || !ACTIONABLE_CONCLUSIONS.has(conclusion)) {
    return { actionable: false, reason: "ci_not_actionable" }
  }

  const prs = lookup(ciObj ?? {}, "pull_requests")
  if (!Array.isArray(prs) || prs.length === 0) {
    return { actionable: false, reason: "ci_no_pr" }
  }

  return { actionable: true, conclusion: conclusion as "failure" | "success" }
}
