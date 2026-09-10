type Settlement = Record<string, unknown>

const ADMITTED_PREFIX = "admitted:"

export type SettlementStatus = "settled" | "failed:workspace_lost" | "failed:runtime" | "failed:aborted"

export function statusForSettlement(settlement: Settlement): SettlementStatus | null {
  if (settlement.outcome === "completed") return "settled"
  if (settlement.outcome === "aborted") return "failed:aborted"
  if (settlement.outcome !== "failed") return null
  const error = settlement.error as Settlement | undefined
  return error?.type === "workspace_lost" ? "failed:workspace_lost" : "failed:runtime"
}

export function submissionSettlementStatus(
  history: Record<string, unknown>,
  submissionId: string,
): SettlementStatus | null {
  const settlements = Array.isArray(history.settlements) ? history.settlements : []
  const receipt = settlements.find((item) => item && typeof item === "object" && item.submissionId === submissionId)
  return receipt ? statusForSettlement(receipt) : null
}

/** Persist the exact Flue submission responsible for an admitted delivery. */
export function admittedStatus(submissionId?: string): string {
  return submissionId ? `${ADMITTED_PREFIX}${submissionId}` : "admitted"
}

/** Extract a Flue submission id from an admitted delivery status. */
export function submissionIdFromAdmittedStatus(status: string): string | null {
  if (!status.startsWith(ADMITTED_PREFIX)) return null
  const submissionId = status.slice(ADMITTED_PREFIX.length)
  return submissionId || null
}

/** Read only explicit settlement receipts from a Flue history snapshot. */
export function settledSubmissionIds(history: Record<string, unknown>): Set<string> {
  const settlements = Array.isArray(history.settlements) ? history.settlements : []
  return new Set(
    settlements
      .filter((settlement): settlement is Settlement => !!settlement && typeof settlement === "object")
      .map((settlement) => settlement.submissionId)
      .filter((submissionId): submissionId is string => typeof submissionId === "string" && submissionId.length > 0),
  )
}
