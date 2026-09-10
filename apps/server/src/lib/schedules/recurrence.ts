import { Temporal } from "@js-temporal/polyfill"

export type ScheduleCadence = "daily" | "weekly" | "monthly"

export type Recurrence = {
  cadence: ScheduleCadence
  time: string
  timezone: string
  dayOfWeek?: number
  dayOfMonth?: number
}

function timeParts(time: string): { hour: number; minute: number } {
  const match = /^(?<hour>[01]\d|2[0-3]):(?<minute>[0-5]\d)$/.exec(time)
  if (!match?.groups) throw new Error("time must use HH:mm")
  return { hour: Number(match.groups.hour), minute: Number(match.groups.minute) }
}

function atLocalTime(date: Temporal.PlainDate, recurrence: Recurrence): Temporal.ZonedDateTime {
  const { hour, minute } = timeParts(recurrence.time)
  return Temporal.ZonedDateTime.from({
    timeZone: recurrence.timezone,
    year: date.year,
    month: date.month,
    day: date.day,
    hour,
    minute,
  })
}

function nextAfter(cursor: Temporal.ZonedDateTime, recurrence: Recurrence): Temporal.ZonedDateTime {
  if (recurrence.cadence === "daily") return atLocalTime(cursor.toPlainDate().add({ days: 1 }), recurrence)

  if (recurrence.cadence === "weekly") {
    if (!recurrence.dayOfWeek || recurrence.dayOfWeek < 1 || recurrence.dayOfWeek > 7) {
      throw new Error("weekly schedules require a dayOfWeek from 1 through 7")
    }
    const days = (recurrence.dayOfWeek - cursor.dayOfWeek + 7) % 7 || 7
    return atLocalTime(cursor.toPlainDate().add({ days }), recurrence)
  }

  if (!recurrence.dayOfMonth || recurrence.dayOfMonth < 1 || recurrence.dayOfMonth > 31) {
    throw new Error("monthly schedules require a dayOfMonth from 1 through 31")
  }
  const nextMonth = cursor.toPlainDate().with({ day: 1 }).add({ months: 1 })
  return atLocalTime(nextMonth.with({ day: Math.min(recurrence.dayOfMonth, nextMonth.daysInMonth) }), recurrence)
}

/** Return future occurrences as ISO instants while preserving local civil time. */
export function nextOccurrences(recurrence: Recurrence, after: string | Date, count: number): string[] {
  if (!Number.isInteger(count) || count < 1) throw new Error("count must be a positive integer")
  const now = Temporal.Instant.from(typeof after === "string" ? after : after.toISOString()).toZonedDateTimeISO(
    recurrence.timezone,
  )
  let next = atLocalTime(now.toPlainDate(), recurrence)

  if (recurrence.cadence === "weekly") {
    if (!recurrence.dayOfWeek || recurrence.dayOfWeek < 1 || recurrence.dayOfWeek > 7) {
      throw new Error("weekly schedules require a dayOfWeek from 1 through 7")
    }
    const days = (recurrence.dayOfWeek - now.dayOfWeek + 7) % 7
    next = atLocalTime(now.toPlainDate().add({ days }), recurrence)
  } else if (recurrence.cadence === "monthly") {
    if (!recurrence.dayOfMonth || recurrence.dayOfMonth < 1 || recurrence.dayOfMonth > 31) {
      throw new Error("monthly schedules require a dayOfMonth from 1 through 31")
    }
    const today = now.toPlainDate()
    next = atLocalTime(today.with({ day: Math.min(recurrence.dayOfMonth, today.daysInMonth) }), recurrence)
  }

  if (Temporal.ZonedDateTime.compare(next, now) <= 0) next = nextAfter(next, recurrence)

  return Array.from({ length: count }, () => {
    const value = next.toInstant().toString()
    next = nextAfter(next, recurrence)
    return value
  })
}
