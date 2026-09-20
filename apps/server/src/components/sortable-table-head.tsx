import { CaretDown, CaretUp, CaretUpDown } from "@phosphor-icons/react"
import { TableHead } from "@/components/ui/table"

export type SortDir = "asc" | "desc"

interface SortableTableHeadProps {
  column: string
  label: React.ReactNode
  sortBy: string | null
  sortDir: SortDir
  onSort: (column: string) => void
  className?: string
}

export function SortableTableHead({ column, label, sortBy, sortDir, onSort, className = "" }: SortableTableHeadProps) {
  const active = sortBy === column
  return (
    <TableHead
      className={`cursor-pointer select-none ${active ? "text-foreground" : ""} ${className}`}
      onClick={() => onSort(column)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active ? (
          sortDir === "asc" ? (
            <CaretUp className="size-3" weight="bold" />
          ) : (
            <CaretDown className="size-3" weight="bold" />
          )
        ) : (
          <CaretUpDown className="size-3 text-muted-foreground/50" />
        )}
      </span>
    </TableHead>
  )
}

/** Toggle helper: clicking the active column flips direction; clicking a new column defaults to the given direction. */
export function toggleSort(
  current: { sortBy: string | null; sortDir: SortDir },
  column: string,
  defaultDir: SortDir = "asc",
): { sortBy: string; sortDir: SortDir } {
  if (current.sortBy === column) {
    return { sortBy: column, sortDir: current.sortDir === "asc" ? "desc" : "asc" }
  }
  return { sortBy: column, sortDir: defaultDir }
}
