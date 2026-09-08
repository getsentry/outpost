import { DurableObject } from "cloudflare:workers"
import type { BaseEnvBindings } from "@/types/env/base"
import { nextRunnerWakeAt } from "./runner-state"
import { readSchedule, renewSlot, settleScheduleRuns, startScheduleRun } from "./service"

type Env = BaseEnvBindings["Bindings"]
export type ScheduleArm = { scheduleId: string; revision: number; nextDueAt: number | null; wakeAt?: number | null }

/** One isolated alarm per configured schedule. D1 remains the source of truth. */
export class ScheduleRunner extends DurableObject<Env> {
  async arm(input: ScheduleArm): Promise<void> {
    const wakeAt = input.nextDueAt === null ? null : (input.wakeAt ?? input.nextDueAt)
    const arm = { ...input, wakeAt }
    await this.ctx.storage.put("arm", arm)
    if (input.nextDueAt === null) {
      await this.ctx.storage.deleteAlarm()
      if (input.scheduleId) {
        await this.env.DB.prepare("UPDATE scheduled_jobs SET armed_revision = ? WHERE id = ?")
          .bind(input.revision, input.scheduleId)
          .run()
      }
      return
    }
    await this.ctx.storage.setAlarm(wakeAt)
    await this.env.DB.prepare("UPDATE scheduled_jobs SET armed_revision = ? WHERE id = ?")
      .bind(input.revision, input.scheduleId)
      .run()
  }

  async runNow(idempotencyKey: string): Promise<{ runId: string; status: string } | null> {
    const arm = await this.ctx.storage.get<ScheduleArm>("arm")
    const schedule = arm ? await readSchedule(this.env, arm.scheduleId) : null
    if (!schedule?.enabled || schedule.archivedAt) return null
    const result = await startScheduleRun(this.env, schedule.id, {
      trigger: "manual",
      intendedAt: Date.now(),
      dedupeKey: `manual:${idempotencyKey}`,
    })
    await this.armNext(schedule.id)
    return result
  }

  async alarm(): Promise<void> {
    const arm = await this.ctx.storage.get<ScheduleArm>("arm")
    const schedule = arm ? await readSchedule(this.env, arm.scheduleId) : null
    if (!arm || !schedule?.enabled || schedule.archivedAt || schedule.nextDueAt === null) {
      await this.arm({ scheduleId: arm?.scheduleId ?? "", revision: schedule?.revision ?? 0, nextDueAt: null })
      return
    }
    if (arm.revision !== schedule.revision || arm.nextDueAt !== schedule.nextDueAt) {
      await this.arm({ scheduleId: schedule.id, revision: schedule.revision, nextDueAt: schedule.nextDueAt })
      return
    }

    await settleScheduleRuns(this.env, schedule.id)
    if (schedule.nextDueAt <= Date.now()) await startScheduleRun(this.env, schedule.id)
    await this.armNext(schedule.id)
  }

  private async armNext(scheduleId: string): Promise<void> {
    const schedule = await readSchedule(this.env, scheduleId)
    if (!schedule?.enabled || schedule.archivedAt || schedule.nextDueAt === null) {
      const arm = await this.ctx.storage.get<ScheduleArm>("arm")
      await this.arm({
        scheduleId: schedule?.id ?? arm?.scheduleId ?? "",
        revision: schedule?.revision ?? 0,
        nextDueAt: null,
      })
      return
    }
    const active = await this.env.DB.prepare(
      "SELECT id FROM scheduled_job_runs WHERE schedule_id = ? AND status IN ('preparing', 'admitting', 'admitted', 'unknown_admission') LIMIT 1",
    )
      .bind(schedule.id)
      .first<{ id: string }>()
    if (active?.id) await renewSlot(this.env, active.id)
    await this.arm({
      scheduleId: schedule.id,
      revision: schedule.revision,
      nextDueAt: schedule.nextDueAt,
      wakeAt: nextRunnerWakeAt({ scheduleDueAt: schedule.nextDueAt, hasActiveRun: Boolean(active), now: Date.now() }),
    })
  }
}
