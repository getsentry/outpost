// Background reconciliation for webhook events stuck in `dispatched`.
//
// An event flips to `dispatched` the moment it is admitted to the agent, but the
// ONLY path that upgrades it to `completed` (markEntityEventsCompleted) runs when
// the dashboard detail page is opened while the agent is idle. Entities nobody
// opens in the UI — most CI-burst PRs — therefore keep their admitted events in
// `dispatched` forever, and the daily cron used to blanket-mark anything older
// than 2h as `failed:timeout`, mislabeling finished work as a failure.
//
// This reconciler asks the live Flue Durable Object (the source of truth): if the
// agent has gone idle, the dispatched work is done → `completed`; only when it is
// still busy or unreachable do we fall back to the `failed:timeout` semantics so a
// genuinely wedged run stays visible.

import type { InProcessHistoryRead } from "@/lib/containers/flue-dispatch"
import { readFlueHistoryInProcess } from "@/lib/containers/flue-dispatch"
import { isFlueHistoryBusy } from "@/lib/containers/flue-session-adapt"
import type { BaseEnvBindings } from "@/types/env/base"

type Env = BaseEnvBindings["Bindings"]

export type ReconcileResult = { entities: number; completed: number; timedOut: number }

/**
 * Decide the terminal status for an entity's stale `dispatched` rows from a live
 * history read. Idle agent → the work finished; anything else (still busy, 404,
 * read error) → keep the timeout so a real stall is not silently hidden.
 */
export function decideReconciledStatus(read: InProcessHistoryRead): "completed" | "failed:timeout" {
  if (read.ok && !isFlueHistoryBusy(read.history)) return "completed"
  return "failed:timeout"
}

/**
 * Reconcile `dispatched` webhook rows older than `cutoffMs`. Returns per-bucket
 * counts for logging. Best-effort per entity: a failed live read leaves that
 * entity's rows as `failed:timeout` rather than aborting the whole sweep.
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
    "SELECT DISTINCT entity_key FROM webhook_events WHERE status = 'dispatched' AND dispatched_at IS NOT NULL AND dispatched_at < ? LIMIT ?",
  )
    .bind(cutoffSec, maxEntities)
    .all<{ entity_key: string }>()

  const entities = stale.results ?? []
  let completed = 0
  let timedOut = 0

  for (const { entity_key: entityKey } of entities) {
    let read: InProcessHistoryRead
    try {
      read = await readFlueHistoryInProcess(env, entityKey)
    } catch (err) {
      read = { ok: false, notFound: false, error: err instanceof Error ? err.message : String(err) }
    }
    const status = decideReconciledStatus(read)

    const res = await env.DB.prepare(
      "UPDATE webhook_events SET status = ?, completed_at = ? WHERE status = 'dispatched' AND dispatched_at IS NOT NULL AND dispatched_at < ? AND entity_key = ?",
    )
      .bind(status, nowSec, cutoffSec, entityKey)
      .run()
    const changes = res.meta.changes ?? 0
    if (status === "completed") completed += changes
    else timedOut += changes
  }

  return { entities: entities.length, completed, timedOut }
}
