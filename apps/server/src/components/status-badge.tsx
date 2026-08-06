import { Badge } from "@/components/ui/badge"

const STATUS_STYLES: Record<
  string,
  { variant: "default" | "secondary" | "outline" | "destructive" | "ghost"; label: string }
> = {
  pending: { variant: "outline", label: "Pending" },
  dispatched: { variant: "secondary", label: "Dispatched" },
  completed: { variant: "default", label: "Completed" },
  failed: { variant: "destructive", label: "Failed" },
  timeout: { variant: "outline", label: "Timeout" },
  running: { variant: "secondary", label: "Running" },
  skipped: { variant: "ghost", label: "Skipped" },
}

export function StatusBadge({ status }: { status: string }) {
  let config = STATUS_STYLES[status]
  if (!config) {
    if (status.startsWith("failed")) {
      config = { variant: "destructive", label: status === "failed:timeout" ? "Timed out" : "Failed" }
    } else if (status.startsWith("d:")) {
      config = { variant: "outline", label: `Stuck (${status.slice(2)})` }
    } else {
      config = { variant: "outline", label: status }
    }
  }
  return <Badge variant={config.variant}>{config.label}</Badge>
}
