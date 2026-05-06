// Hono app for the plugin's HTTP listener. Routes: healthz, webhook
// ingest (one per source), and JSON API for the dashboard SPA.
// Per-route logic lives under ./handlers/.

import { Hono } from "hono"
import { cors } from "hono/cors"
import * as Sentry from "@sentry/bun"
import type { Dedup } from "./dedup"
import { githubWebhookHandler } from "./handlers/github"
import { emailWebhookHandler } from "./handlers/email"
import {
  apiStatsHandler,
  apiEntitiesHandler,
  apiEntityDetailHandler,
  apiDispatchesHandler,
} from "./handlers/api"
import type { Pipeline } from "./pipeline"
import type { LifecycleStore } from "./storage"
import type { NormalizedTrigger } from "./types"

export type AppEnv = {
  Variables: {
    secret: string
    emailSecret: string
    dedup: Dedup
    pipeline: Pipeline
    botLogin: string | null
    githubTriggers: NormalizedTrigger[]
    emailTriggers: NormalizedTrigger[]
    store: LifecycleStore
  }
}

export function createApp(opts: {
  secret: string
  emailSecret: string
  triggers: NormalizedTrigger[]
  dedup: Dedup
  pipeline: Pipeline
  botLogin: string | null
  store: LifecycleStore
  apiToken: string
}): Hono<AppEnv> {
  const githubTriggers = opts.triggers.filter(
    (t) => t.source === "github_webhook",
  )
  const emailTriggers = opts.triggers.filter((t) => t.source === "email")

  const app = new Hono<AppEnv>()

  app.onError((err, c) => {
    Sentry.captureException(err)
    console.error("[opentower] unhandled route error:", err)
    return c.json({ error: "internal server error" }, 500)
  })

  app.get("/healthz", (c) => {
    return c.json({ ok: true, plugin: "opentower" })
  })

  // Sentry middleware: isolate each request into its own scope.
  app.use("*", async (c, next) => {
    await Sentry.withIsolationScope(async (scope) => {
      const method = c.req.method
      const path = new URL(c.req.url).pathname

      scope.setTag("http.method", method)
      scope.setTag("http.route", path)

      const deliveryId = c.req.header("x-github-delivery")
      if (deliveryId) scope.setTag("delivery.id", deliveryId)
      const event = c.req.header("x-github-event")
      if (event) scope.setTag("github.event", event)

      await Sentry.startSpan(
        {
          op: "http.server",
          name: `${method} ${path}`,
          attributes: {
            "http.method": method,
            "http.route": path,
            ...(deliveryId ? { "delivery.id": deliveryId } : {}),
            ...(event ? { "github.event": event } : {}),
          },
        },
        async (span) => {
          await next()
          const status = c.res.status
          span.setAttribute("http.status_code", status)
          span.setStatus({ code: status >= 400 ? 2 : 1 })
        },
      )
    })
  })

  // Webhook ingest routes.
  app.use("/webhooks/*", async (c, next) => {
    c.set("secret", opts.secret)
    c.set("emailSecret", opts.emailSecret)
    c.set("dedup", opts.dedup)
    c.set("pipeline", opts.pipeline)
    c.set("botLogin", opts.botLogin)
    c.set("githubTriggers", githubTriggers)
    c.set("emailTriggers", emailTriggers)
    await next()
  })

  app.post("/webhooks/github", githubWebhookHandler)
  app.post("/webhooks/email", emailWebhookHandler)

  // --- Dashboard JSON API ---

  // CORS for the SPA (runs from a different origin).
  app.use("/api/*", cors({
    origin: "*",
    allowMethods: ["GET", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type"],
    maxAge: 86400,
  }))

  // Bearer token auth for /api/* routes.
  app.use("/api/*", async (c, next) => {
    if (!opts.apiToken) {
      return c.json({ error: "API not configured (OPENTOWER_API_TOKEN not set)" }, 503)
    }
    const authHeader = c.req.header("authorization") ?? ""
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : ""
    if (token !== opts.apiToken) {
      return c.json({ error: "unauthorized" }, 401)
    }
    c.set("store", opts.store)
    await next()
  })

  app.get("/api/stats", apiStatsHandler as never)
  app.get("/api/entities", apiEntitiesHandler as never)
  app.get("/api/entities/:key", apiEntityDetailHandler as never)
  app.get("/api/dispatches", apiDispatchesHandler as never)

  return app
}
