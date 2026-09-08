import { isValidRepoSlug } from "@/lib/containers/chat-run"

const RUN_ID_HEX_LENGTH = 12
const MAX_ENTITY_KEY_LENGTH = 63

/** A fresh conversation key per occurrence; its prefix still lets sandbox prep resolve owner/repo. */
export function createScheduledEntityKey(repo: string, runId: string = crypto.randomUUID()): string {
  if (!isValidRepoSlug(repo)) throw new Error("invalid repository slug")
  const suffix = `#s-${runId
    .replace(/[^0-9a-f]/gi, "")
    .toLowerCase()
    .slice(0, RUN_ID_HEX_LENGTH)}`
  if (suffix.length !== RUN_ID_HEX_LENGTH + 3 || repo.length + suffix.length > MAX_ENTITY_KEY_LENGTH) {
    throw new Error("repository name is too long for an isolated scheduled run")
  }
  return `${repo}${suffix}`
}

/** Metadata only: webhook ingestion may use this to show the created artifact in schedule history. */
export function scheduledRunMarker(runId: string): string {
  return `<!-- jared:schedule-run=${runId} -->`
}

export function extractScheduledRunMarker(body: string | null | undefined): string | null {
  const match = /<!--\s*jared:schedule-run=([a-zA-Z0-9_-]+)\s*-->/.exec(body ?? "")
  return match?.[1] ?? null
}
