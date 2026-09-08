import { z } from "zod"
import { isValidRepoSlug } from "@/lib/containers/chat-run"
import { nextOccurrences, type ScheduleCadence } from "./recurrence"

const MAX_SCHEDULE_REPO_LENGTH = 48
const baseSchema = z.object({
  name: z.string().trim().min(1).max(120),
  repo: z.string().trim().min(3).max(MAX_SCHEDULE_REPO_LENGTH),
  prompt: z.string().trim().min(1).max(20_000),
  cadence: z.enum(["daily", "weekly", "monthly"]),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "time must use HH:mm"),
  timezone: z.string().trim().min(1).max(100),
  dayOfWeek: z.number().int().min(1).max(7).optional(),
  dayOfMonth: z.number().int().min(1).max(31).optional(),
  enabled: z.boolean().default(true),
})

export type ScheduleInput = z.infer<typeof baseSchema>

export function parseScheduleInput(value: unknown): ScheduleInput {
  const input = baseSchema.parse(value)
  if (!isValidRepoSlug(input.repo)) throw new Error("repo must be an owner/name slug")
  if (input.cadence === "weekly" && input.dayOfWeek === undefined)
    throw new Error("dayOfWeek is required for weekly schedules")
  if (input.cadence === "monthly" && input.dayOfMonth === undefined)
    throw new Error("dayOfMonth is required for monthly schedules")
  if (input.cadence !== "weekly" && input.dayOfWeek !== undefined)
    throw new Error("dayOfWeek only applies to weekly schedules")
  if (input.cadence !== "monthly" && input.dayOfMonth !== undefined)
    throw new Error("dayOfMonth only applies to monthly schedules")
  try {
    nextOccurrences(
      {
        cadence: input.cadence as ScheduleCadence,
        time: input.time,
        timezone: input.timezone,
        dayOfWeek: input.dayOfWeek,
        dayOfMonth: input.dayOfMonth,
      },
      new Date(),
      1,
    )
  } catch {
    throw new Error("timezone must be a valid IANA timezone")
  }
  return input
}
