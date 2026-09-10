import { DurableObject } from "cloudflare:workers"
import type { BaseEnvBindings } from "@/types/env/base"
import { nextRunnerWakeAt } from "./runner-state"
import { readSchedule, renewSlot, settleScheduleRuns, startScheduleRun } from "./service"

type Env = BaseEnvBindings["Bindings"]
export type ScheduleArm = { scheduleId: string; revision: number; nextDueAt: number | null; wakeAt?: number | null }

/** One isolated alarm per configured schedule. D1 remains the source of truth. */
export class ScheduleRunner extends DurableObject<Env> {
  /** Reconcile this runner with D1 after an operator mutation. */
  async sync(scheduleId: string): Promise<void> {
    await this.armNext(scheduleId)
  }

  async arm(input: ScheduleArm): Promise<void> {
    // A paused/archived schedule has no due occurrence, but an already-admitted
    // run still needs a short-lived monitor wake-up to settle its history.
    const wakeAt = input.wakeAt ?? input.nextDueAt
    const arm = { ...input, wakeAt }
    await this.ctx.storage.put("arm", arm)
    if (wakeAt === null) {
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

  async runNow(scheduleId: string, idempotencyKey: string): Promise<{ runId: string; status: string } | null> {
    const schedule = await readSchedule(this.env, scheduleId)
    if (!schedule || schedule.archivedAt) return null
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
    if (!arm || !schedule) {
      await this.arm({ scheduleId: arm?.scheduleId ?? "", revision: schedule?.revision ?? 0, nextDueAt: null })
      return
    }
    if (arm.revision !== schedule.revision || arm.nextDueAt !== schedule.nextDueAt) {
      await this.armNext(schedule.id)
      return
    }

    // Durable Object alarms retry at least once but can eventually exhaust
    // their retry budget. Clear the confirmation before external work so the
    // maintenance reconciler can re-arm this schedule after such a failure.
    await this.env.DB.prepare("UPDATE scheduled_jobs SET armed_revision = NULL WHERE id = ? AND revision = ?")
      .bind(schedule.id, schedule.revision)
      .run()
    await settleScheduleRuns(this.env, schedule.id)
    if (schedule.enabled && schedule.nextDueAt !== null && schedule.nextDueAt <= Date.now())
      await startScheduleRun(this.env, schedule.id)
    await this.armNext(schedule.id)
  }

  private async armNext(scheduleId: string): Promise<void> {
    const schedule = await readSchedule(this.env, scheduleId)
    if (!schedule) {
      const arm = await this.ctx.storage.get<ScheduleArm>("arm")
      await this.arm({
        scheduleId: arm?.scheduleId ?? "",
        revision: 0,
        nextDueAt: null,
      })
      return
    }
    const active = await this.env.DB.prepare(
      "SELECT id FROM scheduled_job_runs WHERE schedule_id = ? AND status IN ('preparing', 'admitting', 'admitted', 'unknown_admission') LIMIT 1",
    )
      .bind(schedule.id)
      .first<{ id: string }>()
    if (active?.id) {
      await renewSlot(this.env, active.id)
      if (!schedule.enabled || schedule.archivedAt || schedule.nextDueAt === null) {
        await this.arm({
          scheduleId: schedule.id,
          revision: schedule.revision,
          nextDueAt: null,
          wakeAt: Date.now() + 2 * 60 * 1000,
        })
        return
      }
    } else if (!schedule.enabled || schedule.archivedAt || schedule.nextDueAt === null) {
      await this.arm({ scheduleId: schedule.id, revision: schedule.revision, nextDueAt: null })
      return
    }
    await this.arm({
      scheduleId: schedule.id,
      revision: schedule.revision,
      nextDueAt: schedule.nextDueAt,
      wakeAt: nextRunnerWakeAt({ scheduleDueAt: schedule.nextDueAt, hasActiveRun: Boolean(active), now: Date.now() }),
    })
  }
}
