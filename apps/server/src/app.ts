/**
 * Flue + Outpost route map.
 *
 * Flue's generated Worker entry (`virtual:flue/worker`) imports this default
 * export as the fetch handler. Agent routes are mounted BEFORE rate limiting
 * so in-process / SDK dispatch is not blocked by unidentified callers.
 */

import { createLogger, formatError } from "@jared/utils"
import { createAgentRouter } from "@flue/runtime/routing"
import * as Sentry from "@sentry/cloudflare"
import { Hono } from "hono"
import { contextStorage } from "hono/context-storage"
import { cors } from "hono/cors"
import { HTTPException } from "hono/http-exception"
import { logger } from "hono/logger"
import { requestId } from "hono/request-id"
import { secureHeaders } from "hono/secure-headers"
import { Jared } from "./agents/jared.ts"
import { auth, base, rateLimit } from "./middlewares"
import router from "./routes"
import type { BaseEnvBindings } from "./types/env/base"

const app = new Hono<BaseEnvBindings>()
  .use(
    logger(),
    requestId(),
    cors({
      origin: (origin, c) => {
        const allowedOrigin = c.env.APP_URL
        if (origin === allowedOrigin) return origin
        if (c.env.ENV === "development") {
          try {
            const url = new URL(origin)
            if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
              return origin
            }
          } catch {
            // Invalid origin
          }
        }
        return ""
      },
      credentials: true,
    }),
    secureHeaders(),
    contextStorage(),
    base(),
    auth(),
  )
  // Flue agent surface — before rateLimit so Worker-internal dispatch and
  // dashboard history pulls are not rejected for lacking a rate-limit key.
  .route("/agents/jared", createAgentRouter(Jared))
  .use(rateLimit())
  .route("/", router)
  .onError((err, c) => {
    const log = createLogger({
      namespace: "http",
      level: c.env.ENV === "development" ? "debug" : "info",
    })

    if (c.env.ENV === "development") {
      log.error({ error: formatError(err) }, "unhandled error")
    } else {
      Sentry.captureException(err)
    }

    if (err instanceof HTTPException) {
      return err.getResponse()
    }

    return c.json({ error: "Internal server error" }, 500)
  })

export type AppType = typeof app

/** Flue's generated Worker entry uses this as the fetch handler. */
export default Sentry.withSentry((env: BaseEnvBindings["Bindings"]) => ({ dsn: env.SENTRY_DSN }), app)
