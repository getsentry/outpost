export type MaintenanceOutcome = {
  deleted: number
  timedOut: number
  settled: number
  discussionRetries: number
}

export type MaintenanceRunInput = MaintenanceOutcome & {
  cron: string
  scheduledAt: number
}

/** Persist a small control-plane heartbeat after a cron maintenance pass. */
export async function recordMaintenanceRun(db: D1Database, input: MaintenanceRunInput): Promise<void> {
  const completedAt = Date.now()
  await db
    .prepare("INSERT INTO maintenance_runs (id, cron, scheduled_at, completed_at, outcome) VALUES (?, ?, ?, ?, ?)")
    .bind(
      crypto.randomUUID(),
      input.cron,
      Math.floor(input.scheduledAt / 1000),
      Math.floor(completedAt / 1000),
      JSON.stringify({
        deleted: input.deleted,
        timedOut: input.timedOut,
        settled: input.settled,
        discussionRetries: input.discussionRetries,
      }),
    )
    .run()
}
