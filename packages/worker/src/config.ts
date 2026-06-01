// Config resolution for the Worker control plane.
// Reads trigger configuration from environment variables and normalizes
// triggers. In the new architecture, config is embedded in wrangler.jsonc
// vars and D1, not a JSON file.

import type { Env, NormalizedTrigger } from "./types"

// Default triggers matching the original opentower.config.json.
const DEFAULT_TRIGGERS: NormalizedTrigger[] = [
  {
    name: "github-event",
    source: "github_app",
    events: ["issues", "pull_request", "check_suite:completed", "workflow_run:completed", "push"],
    action: null,
    enabled: true,
    agent: "jared",
    prompt_template:
      "A GitHub webhook just arrived. Read the payload and decide what to do.\n\nBot identity: {{ bot_login }}\nEvent: {{ event }}\nAction: {{ action }}\nDelivery: {{ delivery_id }}\n\nPayload:\n{{ payload }}",
    cwd: null,
  },
  {
    name: "github-comment",
    source: "github_app",
    events: ["pull_request_review_comment", "issue_comment", "pull_request_review"],
    action: null,
    enabled: true,
    agent: "jared",
    prompt_template:
      "A GitHub webhook just arrived. Read the payload and decide what to do.\n\nBot identity: {{ bot_login }}\nEvent: {{ event }}\nAction: {{ action }}\nDelivery: {{ delivery_id }}\n\nPayload:\n{{ payload }}",
    cwd: null,
  },
]

export function normalizeTrigger(
  t: NormalizedTrigger,
  botLogin: string | null,
): NormalizedTrigger {
  const merged: string[] = []
  const seen = new Set<string>()
  for (const raw of t.ignore_authors ?? []) {
    const expanded = raw === "$BOT_LOGIN" ? botLogin : raw
    if (!expanded) continue
    const k = expanded.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    merged.push(expanded)
  }
  return {
    ...t,
    ignore_authors: merged.length > 0 ? merged : undefined,
  }
}

export function getDefaultTriggers(env: Env, botLogin: string | null): NormalizedTrigger[] {
  const agent = env.DEFAULT_AGENT || "jared"

  // Apply the default agent and bot login normalization.
  return DEFAULT_TRIGGERS.map((t) => {
    const trigger = { ...t, agent }
    // Add bot login to ignore_authors for comment triggers.
    if (trigger.name === "github-comment" && botLogin) {
      trigger.ignore_authors = [botLogin]
    }
    return normalizeTrigger(trigger, botLogin)
  })
}
