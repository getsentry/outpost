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
  const config = STATUS_STYLES[status] ?? { variant: "outline" as const, label: status }
  return <Badge variant={config.variant}>{config.label}</Badge>
}
