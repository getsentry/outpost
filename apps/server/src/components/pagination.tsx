import { CaretLeft, CaretRight } from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"

const PAGE_SIZES = [10, 25, 50] as const

interface PaginationFooterProps {
  page: number
  limit: number
  total: number
  totalPages: number
  onPageChange: (page: number) => void
}

export function PaginationFooter({ page, limit, total, totalPages, onPageChange }: PaginationFooterProps) {
  if (totalPages <= 1) return null
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-muted-foreground">
        Showing {(page - 1) * limit + 1}–{Math.min(page * limit, total)} of {total}
      </span>
      <div className="flex items-center gap-1">
        <Button variant="outline" size="xs" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
          <CaretLeft className="size-3" />
          Prev
        </Button>
        <span className="px-2 text-xs tabular-nums text-muted-foreground">
          {page} / {totalPages}
        </span>
        <Button variant="outline" size="xs" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>
          Next
          <CaretRight className="size-3" />
        </Button>
      </div>
    </div>
  )
}

interface PageSizeSelectorProps {
  current: number
  onChange: (size: number) => void
  options?: readonly number[]
  className?: string
}

export function PageSizeSelector({ current, onChange, options = PAGE_SIZES, className = "" }: PageSizeSelectorProps) {
  return (
    <div className={`flex items-center gap-1.5 text-xs text-muted-foreground ${className}`}>
      <span>Per page:</span>
      {options.map((s) => (
        <Button key={s} variant={current === s ? "secondary" : "ghost"} size="xs" onClick={() => onChange(s)}>
          {s}
        </Button>
      ))}
    </div>
  )
}
