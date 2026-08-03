/**
 * Shared model IDs for the Jared multi-agent roster.
 *
 * Tiering goal: spend Opus 4.8 only on judgment (triage / plan / go-no-go),
 * Opus 4.6 on implementation once the plan is fixed, cheap Sonnet on
 * read-only survey, and a fast xAI coding model on mechanical git/gh shipping.
 *
 * All IDs are OpenRouter-style (`openrouter/<provider>/<model>`).
 */
export const Models = {
  /** Primary Jared — triage, routing, planning, final review. */
  triage: "openrouter/anthropic/claude-opus-4.8",
  /** Implementation after a precise plan is ready. */
  implement: "openrouter/anthropic/claude-opus-4.6",
  /** Read-only codebase survey / diff summaries. */
  explore: "openrouter/anthropic/claude-sonnet-4.6",
  /**
   * Mechanical git/gh shipping: commit, push, open/update draft PRs.
   * `grok-code-fast-1` is the durable OpenRouter alias for xAI's coding model
   * (currently routes to grok-build-0.1).
   */
  ship: "openrouter/x-ai/grok-code-fast-1",
  /** Tiny model for OpenCode/Flue "small_model" style helpers if needed. */
  small: "openrouter/anthropic/claude-haiku-4.5",
} as const

export type ModelTier = keyof typeof Models
