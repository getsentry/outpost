export function nextRunnerWakeAt(input: { scheduleDueAt: number; hasActiveRun: boolean; now: number }): number {
  return input.hasActiveRun ? Math.min(input.scheduleDueAt, input.now + 2 * 60 * 1000) : input.scheduleDueAt
}
