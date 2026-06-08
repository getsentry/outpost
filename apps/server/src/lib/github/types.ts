// Shared types for the GitHub webhook handling layer.

/**
 * Represents a GitHub entity (issue or PR) identified from a webhook payload.
 * Used for session affinity — all events related to the same entity
 * can be routed to the same agent session.
 */
export type EntityKey = {
  /** Canonical key: "owner/repo#123" */
  key: string
  /** Repository full name: "owner/repo" */
  repo: string
  /** Issue or PR number */
  number: number
  /** Whether this entity is an issue or pull request */
  kind: "issue" | "pull_request"
  /** Issue numbers referenced by "Fixes #N" / "Closes #N" in a PR body */
  linkedIssues: number[]
}

/**
 * Structured representation of a received webhook event,
 * ready for downstream processing by the agent.
 */
export type WebhookEvent = {
  /** GitHub event name (e.g. "issues", "pull_request", "push") */
  event: string
  /** Event action (e.g. "opened", "closed", "synchronize"), null if none */
  action: string | null
  /** Unique delivery ID from GitHub (X-GitHub-Delivery header) */
  deliveryId: string
  /** Installation ID that sent this event */
  installationId: number | null
  /** The sender's GitHub login */
  sender: string | null
  /** Repository full name */
  repo: string | null
  /** Extracted entity key, if applicable */
  entityKey: EntityKey | null
  /** Raw parsed payload */
  payload: Record<string, unknown>
}
