import { Badge } from "@/components/ui/badge"
import { runStatusNotice } from "@/lib/containers/run-status"

// ---------------------------------------------------------------------------
// Shared color map for run/session statuses.  Every component in the family
// draws from this single source of truth so colours stay consistent.
// ---------------------------------------------------------------------------

const RUN_STATUS_COLORS: Record<string, { dot: string; bg: string; label: string }> = {
  working: {
    dot: "bg-yellow-500 animate-pulse",
    bg: "bg-yellow-50 text-yellow-700 dark:bg-yellow-950/50 dark:text-yellow-300",
    label: "Working",
  },
  // Legacy API value before display-status rollout
  busy: {
    dot: "bg-yellow-500 animate-pulse",
    bg: "bg-yellow-50 text-yellow-700 dark:bg-yellow-950/50 dark:text-yellow-300",
    label: "Working",
  },
  idle: {
    dot: "bg-green-500",
    bg: "bg-green-50 text-green-700 dark:bg-green-950/50 dark:text-green-300",
    label: "Idle",
  },
  historical: {
    dot: "bg-muted-foreground/50",
    bg: "bg-muted text-muted-foreground",
    label: "Historical",
  },
  blocked: { dot: "bg-red-500", bg: "bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300", label: "Blocked" },
  failed: {
    dot: "bg-destructive",
    bg: "bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300",
    label: "Failed",
  },
  interrupted: {
    dot: "bg-destructive",
    bg: "bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300",
    label: "Interrupted",
  },
  cleanup_pending: {
    dot: "bg-destructive",
    bg: "bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300",
    label: "Cleanup Pending",
  },
  sync_unavailable: {
    dot: "bg-amber-500",
    bg: "bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300",
    label: "Sync Unavailable",
  },
  unknown: {
    dot: "bg-gray-400",
    bg: "bg-gray-50 text-gray-600 dark:bg-gray-900 dark:text-gray-400",
    label: "Offline",
  },
}

function resolve(status: string) {
  return RUN_STATUS_COLORS[status] ?? RUN_STATUS_COLORS.unknown
}

// ---------------------------------------------------------------------------
// StatusDot — a small colored circle representing a run status.
// ---------------------------------------------------------------------------

export function StatusDot({ status, className = "" }: { status: string; className?: string }) {
  return <span className={`inline-block size-2 rounded-full ${resolve(status).dot} ${className}`} />
}

// ---------------------------------------------------------------------------
// RunStatusIndicator — colored dot + label pill used on the sessions table.
// For attention-notice statuses it falls back to a Badge.
// ---------------------------------------------------------------------------

export function RunStatusIndicator({ status }: { status: string }) {
  const notice = runStatusNotice(status)
  if (notice) return <Badge variant={status === "sync_unavailable" ? "outline" : "destructive"}>{notice.title}</Badge>
  const c = resolve(status)
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-mono text-[11px] font-medium ${c.bg}`}
    >
      <span className={`inline-block size-1.5 rounded-full ${c.dot}`} />
      {c.label}
    </span>
  )
}
