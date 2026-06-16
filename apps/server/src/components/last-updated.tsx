import { ArrowClockwise } from "@phosphor-icons/react"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"

function getRelativeTime(timestamp: number): string {
  const diffMs = Date.now() - timestamp
  const diffSecs = Math.floor(diffMs / 1000)
  const diffMins = Math.floor(diffSecs / 60)

  if (diffSecs < 5) return "just now"
  if (diffSecs < 60) return `${diffSecs}s ago`
  return `${diffMins}m ago`
}

export function LastUpdated({
  dataUpdatedAt,
  isFetching,
  onRefresh,
}: {
  dataUpdatedAt: number
  isFetching: boolean
  onRefresh: () => void
}) {
  const [, setTick] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 10_000)
    return () => clearInterval(id)
  }, [])

  if (!dataUpdatedAt) return null

  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span>Updated {getRelativeTime(dataUpdatedAt)}</span>
      <Button variant="ghost" size="icon-xs" onClick={onRefresh} disabled={isFetching}>
        <ArrowClockwise className={`size-3 ${isFetching ? "animate-spin" : ""}`} />
      </Button>
    </div>
  )
}
