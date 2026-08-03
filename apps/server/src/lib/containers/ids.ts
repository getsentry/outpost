/**
 * Shared identity helpers for Flue conversations and Cloudflare Sandboxes.
 *
 * CRITICAL: prep (ensureSandboxReady), Flue conversation ids, and
 * Jared's useSandbox(getSandbox(...)) MUST use the same id. Entity keys look
 * like `getsentry/cli#1107` — sanitize to DNS-safe form once, everywhere.
 */

/** Sanitize an entity key into a stable Flue conversation / Sandbox id. */
export function toAgentInstanceId(entityKey: string): string {
  const id = entityKey
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
  if (!id) return "unknown"
  // Avoid reserved sandbox names.
  const reserved = new Set(["www", "api", "admin", "root", "system", "cloudflare", "workers"])
  return reserved.has(id) ? `agent-${id}` : id
}
