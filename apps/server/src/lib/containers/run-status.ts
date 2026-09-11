/** Shared, presentation-only run states. Keep Worker dependencies out of this module. */
export type AttentionRunStatus = "blocked" | "failed" | "interrupted" | "cleanup_pending" | "sync_unavailable"
export type DisplayRunStatus = "working" | "idle" | "historical" | "unknown" | AttentionRunStatus

const NOTICES: Record<AttentionRunStatus, { title: string; description: string }> = {
  blocked: {
    title: "Workspace recovery required",
    description:
      "The workspace was lost or a command's result is uncertain. Inspect surviving files and command effects before starting another turn.",
  },
  failed: {
    title: "Run failed",
    description: "The last turn failed. Review its messages and tool results before deciding what to retry.",
  },
  interrupted: {
    title: "Run interrupted",
    description: "The last turn was cancelled or interrupted. Check any in-flight command effects before continuing.",
  },
  cleanup_pending: {
    title: "Cleanup incomplete",
    description:
      "Some cleanup may have completed. Retry Destroy to finish permanently deleting this run. New messages are disabled until cleanup finishes.",
  },
  sync_unavailable: {
    title: "Live sync unavailable",
    description: "Showing a saved snapshot. The current runtime state could not be confirmed.",
  },
}

export function runStatusNotice(status: string) {
  return Object.hasOwn(NOTICES, status)
    ? { state: status as AttentionRunStatus, ...NOTICES[status as AttentionRunStatus] }
    : null
}

export function runStatusLabel(status: string): string {
  if (status === "working" || status === "busy") return "Working"
  if (status === "idle") return "Idle"
  if (status === "historical") return "Historical"
  return runStatusNotice(status)?.title ?? "Unknown"
}
