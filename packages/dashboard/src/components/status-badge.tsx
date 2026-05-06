import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

const statusStyles: Record<string, string> = {
  started: "bg-blue-500/15 text-blue-700 border-blue-500/20 dark:text-blue-400",
  completed: "bg-green-500/15 text-green-700 border-green-500/20 dark:text-green-400",
  failed: "bg-red-500/15 text-red-700 border-red-500/20 dark:text-red-400",
  timeout: "bg-amber-500/15 text-amber-700 border-amber-500/20 dark:text-amber-400",
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="outline" className={cn("font-mono text-xs", statusStyles[status])}>
      {status}
    </Badge>
  )
}
