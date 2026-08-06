/**
 * Chat runs — agent conversations an operator starts from the dashboard instead
 * of a GitHub webhook.
 *
 * A chat run still needs a repo so the sandbox gets a cloned `/workspace/repo`,
 * so the entity key reuses the familiar `owner/repo#suffix` shape with a
 * non-numeric suffix: `getsentry/outpost#chat-9f2ab41c`. `parseOwnerRepo` keeps
 * resolving the repo and `toAgentInstanceId` keeps producing a DNS-safe sandbox
 * id, while the numeric `#123` parse behind issue links returns null — a chat
 * run has no issue or PR to link to.
 *
 * Pure string helpers with no runtime dependencies: both the Worker and the
 * dashboard bundle import this module.
 */

const REPO_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/
const CHAT_ENTITY_KEY = /^([^#]+)#chat-[0-9a-f]+$/

/**
 * `toAgentInstanceId` truncates to 63 characters, and a truncated key would drop
 * the `chat-<id>` suffix — two chat runs on the same repo would then collide on
 * one sandbox and one Flue conversation. Keep room for `#chat-` + 12 hex chars
 * (45 + 6 + 12 = 63). Real `owner/repo` slugs are far shorter.
 */
export const MAX_CHAT_REPO_LENGTH = 45

/** Hex chars kept from the UUID — 48 bits is enough at dashboard volumes. */
export const CHAT_ID_HEX_LENGTH = 12

/** How long a chat run is considered "still starting" before follow-ups are allowed. */
export const CHAT_STARTING_WINDOW_MS = 5 * 60 * 1000

/** Prefix on every operator-typed turn, so the agent can tell it from webhook text. */
export const OPERATOR_PROMPT_PREFIX = "Operator guidance:\n\n"

/** Opening line of a chat run's first prompt. */
export const CHAT_PROMPT_HEADER = "New operator chat"

/** Separates the chat-run framing header from what the operator actually typed. */
export const CHAT_REQUEST_MARKER = "\n## Request\n\n"

/** Wrap free-form operator text admitted into a live conversation. */
export function formatOperatorPrompt(text: string): string {
  return `${OPERATOR_PROMPT_PREFIX}${text}`
}

/**
 * Recover the operator's own words from a prompt the Worker framed for the
 * agent, so a chat transcript reads like what the human typed. Returns the
 * prompt unchanged when it carries no operator framing (e.g. webhook events).
 */
export function operatorText(prompt: string): string {
  if (prompt.startsWith(OPERATOR_PROMPT_PREFIX)) return prompt.slice(OPERATOR_PROMPT_PREFIX.length)
  if (prompt.startsWith(CHAT_PROMPT_HEADER)) {
    // Anchored on the header so a webhook payload that happens to contain the
    // marker can't get its message body truncated.
    const request = prompt.indexOf(CHAT_REQUEST_MARKER)
    if (request !== -1) return prompt.slice(request + CHAT_REQUEST_MARKER.length)
  }
  return prompt
}

/** True when `repo` is a plausible `owner/name` slug we can clone. */
export function isValidRepoSlug(repo: string): boolean {
  return repo.length <= MAX_CHAT_REPO_LENGTH && REPO_SLUG.test(repo)
}

/** Mint a fresh entity key for a chat run against `repo`. */
export function createChatEntityKey(repo: string, id: string = crypto.randomUUID()): string {
  return `${repo}#chat-${id.replace(/[^0-9a-f]/g, "").slice(0, CHAT_ID_HEX_LENGTH)}`
}

/** True when this entity key belongs to a dashboard-started chat run. */
export function isChatEntityKey(entityKey: string): boolean {
  return chatEntityRepo(entityKey) !== null
}

/** The `owner/repo` a chat run targets, or null when it is not a chat run. */
export function chatEntityRepo(entityKey: string): string | null {
  const repo = CHAT_ENTITY_KEY.exec(entityKey)?.[1]
  return repo && isValidRepoSlug(repo) ? repo : null
}
