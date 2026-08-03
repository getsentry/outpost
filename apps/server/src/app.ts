/**
 * Flue + Outpost route map.
 *
 * On the Cloudflare target, Flue treats this default export as the Worker fetch
 * handler composition surface. Existing Outpost API routes stay under /api/*;
 * the Jared agent is mounted at /agents/jared/:conversationId.
 */

import { createAgentRouter } from "@flue/runtime/routing"
import { Hono } from "hono"
import { contextStorage } from "hono/context-storage"
import { cors } from "hono/cors"
import { HTTPException } from "hono/http-exception"
import { logger } from "hono/logger"
import { requestId } from "hono/request-id"
import { secureHeaders } from "hono/secure-headers"
import { createLogger, formatError } from "@jared/utils"
import * as Sentry from "@sentry/cloudflare"
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
    rateLimit(),
  )
  // Flue agent surface — unauthenticated from Worker-internal / SDK callers.
  // Protect with network controls; conversation ids are entity keys.
  .route("/agents/jared", createAgentRouter(Jared))
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
export default app
