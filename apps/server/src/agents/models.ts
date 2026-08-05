/**
 * Shared model IDs for the Jared multi-agent roster.
 *
 * Tiering goal: spend the premium model only on heavy judgment (planning,
 * go/no-go on real code changes). Everything else runs on balanced-cost
 * models — a cheap primary for lightweight situations (comment replies,
 * approvals), a cheap reader for survey, a dedicated coder for implementation,
 * and a fast, cheap model for mechanical git/gh shipping.
 *
 * All IDs are OpenRouter-style (`openrouter/<provider>/<model>`) and every slug
 * below is validated against OpenRouter's live model list.
 */
export const Models = {
  /**
   * Heavy primary — triage + plan + go/no-go for situations that produce code
   * (resolve-issue, fix-ci, review-pr). Reserved for real judgment.
   */
  triage: "openrouter/anthropic/claude-opus-4.8",
  /**
   * Light primary — same router/handler role for lightweight situations
   * (respond-to-comment, approval reviews, mark-pr-ready) where Opus is
   * overkill. Strong, cheap, 1M context.
   */
  triageLight: "openrouter/x-ai/grok-4.3",
  /** Implementation after a precise plan is ready — a dedicated coding model. */
  implement: "openrouter/moonshotai/kimi-k2.7-code",
  /** Read-only codebase survey / diff summaries — cheap reader, big context. */
  explore: "openrouter/openai/gpt-5-mini",
  /**
   * Mechanical git/gh shipping: commit, push, open/update draft PRs.
   * `grok-build-0.1` is xAI's current fast coding model on OpenRouter (the old
   * `grok-code-fast-1` alias was delisted).
   */
  ship: "openrouter/x-ai/grok-build-0.1",
  /** Tiny model for Flue "small_model" style helpers if needed. */
  small: "openrouter/anthropic/claude-haiku-4.5",
} as const

export type ModelTier = keyof typeof Models

/**
 * A lightweight, machine-readable marker the Worker embeds in the event prompt
 * so the primary agent can pick a model per event. Kept as an HTML comment so
 * it is invisible to humans reading the conversation and ignored by the agent.
 */
const MODEL_TIER_RE = /jared:model-tier=(\w+)/

/**
 * Pick the primary model for the message currently being handled.
 *
 * Reads the `jared:model-tier=` marker the Worker embeds in `formatEventPrompt`.
 * Defaults to the heavy primary (Opus) for anything unmarked — signals
 * (scheduled follow-ups) and any event where the marker is missing — so a
 * missing/garbled hint can never silently downgrade real work.
 */
export function modelForDelivery(delivery: { kind: string; body?: string }): string {
  if (delivery.kind === "user" && typeof delivery.body === "string") {
    const tier = MODEL_TIER_RE.exec(delivery.body)?.[1]
    if (tier === "light") return Models.triageLight
  }
  return Models.triage
}
