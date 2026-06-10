// Lightweight structured JSON logger for Cloudflare Workers.
//
// Compatible with @hono/structured-logger's BaseLogger interface
// (pino-style: info(obj, msg?) signature). No Node.js dependencies.
// Uses console.log/warn/error which CF Workers capture natively.

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const

export type LogLevel = keyof typeof LOG_LEVELS

export interface LoggerOptions {
  /** Logger namespace, added to every log entry as `ns` */
  namespace?: string
  /** Minimum log level (default: "info") */
  level?: LogLevel
  /** Extra fields merged into every log entry */
  bindings?: Record<string, unknown>
}

export interface Logger {
  debug(obj: unknown, msg?: string, ...args: unknown[]): void
  info(obj: unknown, msg?: string, ...args: unknown[]): void
  warn(obj: unknown, msg?: string, ...args: unknown[]): void
  error(obj: unknown, msg?: string, ...args: unknown[]): void
  /** Create a child logger with additional bindings merged into every entry */
  child(bindings: Record<string, unknown>): Logger
}

/**
 * Create a structured JSON logger.
 *
 * Supports two calling conventions:
 *   logger.info("message")            — string-first (simple)
 *   logger.info({ key: "val" }, "msg") — object-first (pino-style, BaseLogger compatible)
 */
export function createLogger(opts: LoggerOptions = {}): Logger {
  const minLevel = LOG_LEVELS[opts.level ?? "info"]
  const namespace = opts.namespace
  const baseBindings = opts.bindings ?? {}

  function emit(level: LogLevel, obj: unknown, msg?: string, ..._args: unknown[]): void {
    if (LOG_LEVELS[level] < minLevel) return

    let logMsg: string | undefined
    let context: Record<string, unknown> = {}

    if (typeof obj === "string") {
      // Called as logger.info("message")
      logMsg = obj
    } else if (obj !== null && obj !== undefined && typeof obj === "object") {
      // Called as logger.info({ key: "val" }, "message") — pino/BaseLogger style
      context = obj as Record<string, unknown>
      logMsg = msg
    } else {
      logMsg = String(obj)
    }

    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      ...(namespace ? { ns: namespace } : {}),
      ...baseBindings,
      ...context,
      ...(logMsg ? { msg: logMsg } : {}),
    }

    const json = JSON.stringify(entry)
    switch (level) {
      case "error":
        console.error(json)
        break
      case "warn":
        console.warn(json)
        break
      default:
        console.log(json)
        break
    }
  }

  const logger: Logger = {
    debug: (obj, msg?, ...args) => emit("debug", obj, msg, ...args),
    info: (obj, msg?, ...args) => emit("info", obj, msg, ...args),
    warn: (obj, msg?, ...args) => emit("warn", obj, msg, ...args),
    error: (obj, msg?, ...args) => emit("error", obj, msg, ...args),
    child(bindings: Record<string, unknown>): Logger {
      return createLogger({
        namespace,
        level: opts.level,
        bindings: { ...baseBindings, ...bindings },
      })
    },
  }

  return logger
}

/**
 * Extract a readable error message from an unknown error value.
 * Handles Error objects, strings, and arbitrary values.
 */
export function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? err.message
  }
  if (typeof err === "string") {
    return err
  }
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}
