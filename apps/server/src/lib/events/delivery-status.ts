type Settlement = Record<string, unknown>

const ADMITTED_PREFIX = "admitted:"

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
