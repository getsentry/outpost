// Background reconciliation for admitted webhook deliveries.
//
// A dashboard read cannot establish that a particular webhook delivery was
// handled: one conversation can receive several submissions in a burst. Flue's
// settlement receipt is the reliable boundary, so reconciliation maps each
// admitted delivery to its exact submission id and settles only that row.

import type { InProcessHistoryRead } from "@/lib/containers/flue-dispatch"
import { readFlueHistoryInProcess } from "@/lib/containers/flue-dispatch"
import type { BaseEnvBindings } from "@/types/env/base"
import { settledSubmissionIds } from "./delivery-status"

type Env = BaseEnvBindings["Bindings"]

export type ReconcileResult = { entities: number; settled: number; timedOut: number }

/**
 * Return `settled` only when the exact admitted submission has a Flue settlement.
 * An idle conversation is not evidence for a different submission in the same
 * conversation, so it intentionally returns null.
 */
export function settledStatusForAdmission(read: InProcessHistoryRead, submissionId: string): "settled" | null {
  return read.ok && settledSubmissionIds(read.history).has(submissionId) ? "settled" : null
}

/** Legacy convenience for callers that need a terminal timeout fallback. */
export function decideReconciledStatus(read: InProcessHistoryRead, submissionId: string): "settled" | "failed:timeout" {
  return settledStatusForAdmission(read, submissionId) ?? "failed:timeout"
}

/**
 * Reconcile admitted webhook rows older than `cutoffMs`. Each Flue settlement
 * updates only its matching delivery. Phase 1 has no submission receipt, so it
 * cannot be settled speculatively and times out visibly at the same cutoff.
 */
export async function reconcileStuckDispatched(
  env: Env,
  scheduledTime: number,
  opts: { cutoffMs?: number; maxEntities?: number } = {},
): Promise<ReconcileResult> {
  const cutoffMs = opts.cutoffMs ?? 2 * 60 * 60 * 1000
  const maxEntities = opts.maxEntities ?? 100
  const cutoffSec = Math.floor((scheduledTime - cutoffMs) / 1000)
  const nowSec = Math.floor(scheduledTime / 1000)

  const stale = await env.DB.prepare(
    "SELECT id, entity_key, status FROM webhook_events WHERE (status IN ('dispatched', 'admitted') OR status LIKE 'admitted:%') AND dispatched_at IS NOT NULL AND dispatched_at < ? ORDER BY dispatched_at LIMIT ?",
  )
    .bind(cutoffSec, maxEntities)
    .all<{ id: string; entity_key: string; status: string }>()

  const rows = stale.results ?? []
  const byEntity = new Map<string, Array<{ id: string; status: string }>>()
  for (const row of rows) {
    const entries = byEntity.get(row.entity_key) ?? []
    entries.push({ id: row.id, status: row.status })
    byEntity.set(row.entity_key, entries)
  }

  let settled = 0
  let timedOut = 0

  for (const [entityKey, entries] of byEntity) {
    let read: InProcessHistoryRead | undefined
    if (entries.some((entry) => entry.status.startsWith("admitted:"))) {
      try {
        read = await readFlueHistoryInProcess(env, entityKey)
      } catch (err) {
        read = { ok: false, notFound: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
    for (const entry of entries) {
      const submissionId = entry.status.slice("admitted:".length)
      const status =
        read && entry.status.startsWith("admitted:") ? decideReconciledStatus(read, submissionId) : "failed:timeout"
      const res = await env.DB.prepare(
        "UPDATE webhook_events SET status = ?, completed_at = ? WHERE id = ? AND status = ?",
      )
        .bind(status, nowSec, entry.id, entry.status)
        .run()
      const changes = res.meta.changes ?? 0
      if (status === "settled") settled += changes
      else timedOut += changes
    }
  }

  return { entities: byEntity.size, settled, timedOut }
}
