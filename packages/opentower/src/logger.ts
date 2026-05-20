// Structured logger for opentower. Outputs JSON lines to stdout/stderr
// with consistent fields: timestamp, level, msg, and arbitrary context.
// Replaces ad-hoc console.log/console.error calls with a unified format
// that's easier to parse in log aggregation systems.

export type LogLevel = "debug" | "info" | "warn" | "error"

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

let minLevel: LogLevel = ((): LogLevel => {
  const env = process.env.OPENTOWER_LOG_LEVEL?.toLowerCase()
  if (env && env in LEVEL_ORDER) return env as LogLevel
  return "info"
})()

export function setLogLevel(level: LogLevel) {
  minLevel = level
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel]
}

function formatLog(level: LogLevel, msg: string, ctx?: Record<string, unknown>): string {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...ctx,
  }
  return JSON.stringify(entry)
}

/** Extract a human-readable message from an unknown error value.
 *  Includes the stack trace when available. */
export function formatError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`
  return String(err)
}

export const logger = {
  debug(msg: string, ctx?: Record<string, unknown>) {
    if (shouldLog("debug")) console.log(formatLog("debug", msg, ctx))
  },
  info(msg: string, ctx?: Record<string, unknown>) {
    if (shouldLog("info")) console.log(formatLog("info", msg, ctx))
  },
  warn(msg: string, ctx?: Record<string, unknown>) {
    if (shouldLog("warn")) console.warn(formatLog("warn", msg, ctx))
  },
  error(msg: string, ctx?: Record<string, unknown>) {
    if (shouldLog("error")) console.error(formatLog("error", msg, ctx))
  },
}
