// Outpost Worker: Cloudflare Worker control plane that receives GitHub
// webhooks, matches triggers, dispatches work to sandbox containers,
// serves the dashboard API, and runs cron jobs.
//
// Architecture:
//   Worker (this file) = control plane
//   SandboxContainer (sandbox.ts) = per-entity container running OpenCode
//   D1 = lifecycle database (entities, dispatches, cron jobs)

import { createGitHubAppAuth, type GitHubAppAuth } from "./auth"
import { getDefaultTriggers } from "./config"
import { makeCronScheduler, type CronScheduler } from "./cron"
import { handleGithubAppWebhook } from "./handlers/github-app"
import {
  apiCronCreateHandler,
  apiCronDeleteHandler,
  apiCronExecutionsHandler,
  apiCronGetHandler,
  apiCronListHandler,
  apiCronTriggerHandler,
  apiCronUpdateHandler,
  apiDispatchesHandler,
  apiEntitiesHandler,
  apiEntityDetailHandler,
  apiGetRetentionHandler,
  apiPruneHandler,
  apiSetRetentionHandler,
  apiStatsHandler,
} from "./handlers/api"
import { safeTokenCompare } from "./hmac"
import { formatError, logger } from "./logger"
import { createLifecycleStore, type LifecycleStore } from "./storage"
import type { Env, NormalizedTrigger } from "./types"

// Re-export the SandboxContainer for wrangler to discover.
export { SandboxContainer } from "./sandbox"

// Cached state across requests within a single Worker isolate.
let cachedAuth: GitHubAppAuth | null = null
let cachedBotLogin: string | null = null
let botLoginResolved = false

function getAuth(env: Env): GitHubAppAuth | null {
  if (cachedAuth) return cachedAuth
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) return null
  const privateKey = env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n")
  cachedAuth = createGitHubAppAuth(env.GITHUB_APP_ID, privateKey)
  return cachedAuth
}

async function getBotLogin(auth: GitHubAppAuth): Promise<string | null> {
  if (botLoginResolved) return cachedBotLogin
  try {
    const slug = await auth.getAppSlug()
    cachedBotLogin = `${slug}[bot]`
    botLoginResolved = true
  } catch {
    // Don't set botLoginResolved — retry on next request so transient
    // failures don't permanently disable the self-loop guard.
    return null
  }
  return cachedBotLogin
}

async function getGhToken(auth: GitHubAppAuth): Promise<string> {
  try {
    const installationId = await auth.getDefaultInstallationId()
    return await auth.getInstallationToken(installationId)
  } catch {
    return ""
  }
}

// Route matching helpers.
function matchPath(
  pattern: string,
  pathname: string,
): Record<string, string> | null {
  const patternParts = pattern.split("/")
  const pathParts = pathname.split("/")
  if (patternParts.length !== pathParts.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(":")) {
      params[patternParts[i].slice(1)] = pathParts[i]
    } else if (patternParts[i] !== pathParts[i]) {
      return null
    }
  }
  return params
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const { pathname } = url
    const method = request.method

    // CORS support.
    const corsOrigin = env.OPENTOWER_CORS_ORIGIN || null
    if (corsOrigin && method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": corsOrigin,
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
          "Access-Control-Max-Age": "86400",
        },
      })
    }

    const addCors = (response: Response): Response => {
      if (!corsOrigin) return response
      const headers = new Headers(response.headers)
      headers.set("Access-Control-Allow-Origin", corsOrigin)
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      })
    }

    try {
      // Health check.
      if (pathname === "/healthz" && method === "GET") {
        return addCors(Response.json({ ok: true, service: "outpost-worker" }))
      }

      // GitHub App webhook endpoint.
      if (pathname === "/webhooks/github-app" && method === "POST") {
        const auth = getAuth(env)
        if (!auth) {
          return addCors(
            Response.json({ error: "GitHub App not configured" }, { status: 503 }),
          )
        }

        const store = createLifecycleStore(env.DB)
        const botLogin = await getBotLogin(auth)
        const triggers = getDefaultTriggers(env, botLogin)

        const response = await handleGithubAppWebhook(
          request,
          env,
          ctx,
          store,
          auth,
          triggers,
          botLogin,
        )
        return addCors(response)
      }

      // Dashboard API routes - require authentication.
      if (pathname.startsWith("/api/")) {
        const apiToken = env.OPENTOWER_API_TOKEN
        if (!apiToken) {
          return addCors(
            Response.json({ error: "API not configured (OPENTOWER_API_TOKEN not set)" }, { status: 503 }),
          )
        }

        const authHeader = request.headers.get("authorization") ?? ""
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : ""
        const valid = await safeTokenCompare(token, apiToken)
        if (!token || !valid) {
          return addCors(Response.json({ error: "unauthorized" }, { status: 401 }))
        }

        const store = createLifecycleStore(env.DB)
        const auth = getAuth(env)
        const ghToken = auth ? await getGhToken(auth) : ""
        const scheduler = makeCronScheduler({
          store,
          env,
          ghToken,
          defaultAgent: env.DEFAULT_AGENT || "jared",
        })

        // Route API requests.
        if (pathname === "/api/stats" && method === "GET") {
          return addCors(await apiStatsHandler(store))
        }
        if (pathname === "/api/entities" && method === "GET") {
          return addCors(await apiEntitiesHandler(request, store))
        }
        const entityMatch = matchPath("/api/entities/:key", pathname)
        if (entityMatch && method === "GET") {
          return addCors(await apiEntityDetailHandler(request, store, entityMatch.key))
        }
        if (pathname === "/api/dispatches" && method === "GET") {
          return addCors(await apiDispatchesHandler(request, store))
        }
        if (pathname === "/api/retention" && method === "GET") {
          return addCors(await apiGetRetentionHandler(store))
        }
        if (pathname === "/api/retention" && method === "PUT") {
          return addCors(await apiSetRetentionHandler(request, store))
        }
        if (pathname === "/api/retention/prune" && method === "POST") {
          return addCors(await apiPruneHandler(store))
        }

        // Cron routes.
        if (pathname === "/api/cron" && method === "GET") {
          return addCors(await apiCronListHandler(request, store))
        }
        if (pathname === "/api/cron" && method === "POST") {
          return addCors(await apiCronCreateHandler(request, store, scheduler))
        }
        const cronMatch = matchPath("/api/cron/:id", pathname)
        if (cronMatch) {
          if (method === "GET") return addCors(await apiCronGetHandler(store, cronMatch.id))
          if (method === "PUT") return addCors(await apiCronUpdateHandler(request, store, scheduler, cronMatch.id))
          if (method === "DELETE") return addCors(await apiCronDeleteHandler(store, cronMatch.id))
        }
        const cronTriggerMatch = matchPath("/api/cron/:id/trigger", pathname)
        if (cronTriggerMatch && method === "POST") {
          return addCors(await apiCronTriggerHandler(store, scheduler, cronTriggerMatch.id))
        }
        const cronExecMatch = matchPath("/api/cron/:id/executions", pathname)
        if (cronExecMatch && method === "GET") {
          return addCors(await apiCronExecutionsHandler(request, store, cronExecMatch.id))
        }

        return addCors(Response.json({ error: "not found" }, { status: 404 }))
      }

      return addCors(Response.json({ error: "not found" }, { status: 404 }))
    } catch (err) {
      logger.error("unhandled error", { error: formatError(err) })
      return addCors(Response.json({ error: "internal server error" }, { status: 500 }))
    }
  },

  // Cron trigger handler: runs every minute to check for due cron jobs.
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const store = createLifecycleStore(env.DB)
    const auth = getAuth(env)
    const ghToken = auth ? await getGhToken(auth) : ""

    const scheduler = makeCronScheduler({
      store,
      env,
      ghToken,
      defaultAgent: env.DEFAULT_AGENT || "jared",
    })

    ctx.waitUntil(scheduler.tick())

    // Periodically prune dedup entries.
    ctx.waitUntil(store.pruneDedup())
  },
}
