// Shared initialization logic for both plugin and standalone modes.
// This module extracts the common bootstrap sequence: config parsing,
// trigger normalization, infrastructure creation, handler/cron setup.

import { homedir } from "node:os"
import { join } from "node:path"
import * as Sentry from "@sentry/bun"
import type { Hono } from "hono"
import { resolveBotLogin } from "./bot-identity"
import { configPath, normalizeTrigger, readWebhookConfig, resolveGithubAppFromEnv } from "./config"
import { type CronScheduler, makeCronScheduler } from "./cron"
import { type Dedup, makeDedup } from "./dedup"
import type { GitHubAppAuth } from "./github-app-auth"
import { type AppEnv, createApp } from "./handler"
import { createHandlers } from "./handlers/registry"
import type { AgentClient, HandlerContext } from "./interfaces"
import { logger } from "./logger"
import { type Pipeline, makePipeline } from "./pipeline"
import { type DrainCounter, makeDrainCounter, makeSemaphore } from "./semaphore"
import { DEFAULT_RETENTION_DAYS, type LifecycleStore, openLifecycleStore } from "./storage"

export type BootstrapResult = {
  app: Hono<AppEnv>
  server: ReturnType<typeof Bun.serve>
  store: LifecycleStore
  pipeline: Pipeline
  cronScheduler: CronScheduler
  drainCounter: DrainCounter
  dedup: Dedup
  botLogin: string | null
  defaultAgent: string
  client: AgentClient
  retentionInterval: ReturnType<typeof setInterval>
  auth: GitHubAppAuth | null
  tokenRefreshTimer: ReturnType<typeof setInterval> | null
}

export type BootstrapOptions = {
  client: AgentClient
  defaultCwd: string
}

export async function bootstrap(opts: BootstrapOptions): Promise<BootstrapResult | null> {
  const cfg = await readWebhookConfig()
  logger.info("config loaded", { path: configPath() })

  const port = cfg.port ?? Number(process.env.WEBHOOK_PORT ?? "5050")
  const timeoutMs = cfg.timeout_ms ?? 1_800_000
  const maxConcurrent = Math.max(1, cfg.max_concurrent ?? 2)
  const defaultCwd = cfg.default_cwd ?? opts.defaultCwd

  const githubApp = cfg.github_app ?? resolveGithubAppFromEnv()
  if (!githubApp) {
    logger.warn(
      "no GitHub App credentials configured -- set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_WEBHOOK_SECRET to enable webhook handling",
    )
    return null
  }

  const triggers = (cfg.triggers ?? []).map((t) => normalizeTrigger(t, null))
  if (triggers.length === 0) {
    logger.info("no triggers configured -- listener disabled", { path: configPath() })
    return null
  }

  const batchWindowMs = cfg.batch_window_ms ?? 5_000
  const dedup = makeDedup()
  const semaphore = makeSemaphore(maxConcurrent)
  const drainCounter = makeDrainCounter()

  const dbPath = process.env.LIFECYCLE_DB_PATH ?? join(homedir(), "dev", ".opencode", "lifecycle.db")
  const store = openLifecycleStore(dbPath)
  logger.info("lifecycle store opened", { path: dbPath })

  const pipeline = makePipeline({
    client: opts.client,
    defaultCwd,
    timeoutMs,
    semaphore,
    drainCounter,
    store,
    batchWindowMs,
  })

  const apiToken = process.env.OPENTOWER_API_TOKEN ?? ""
  if (!apiToken) {
    logger.warn("OPENTOWER_API_TOKEN not set -- /api/* endpoints will reject with 503")
  }

  // Data retention: prune old dispatches/entities on startup and every 24h.
  const storedRetention = store.getRetentionDays()
  const retentionDays = cfg.retention_days ?? storedRetention ?? DEFAULT_RETENTION_DAYS
  if (!storedRetention) store.setRetentionDays(retentionDays)
  const pruneResult = store.pruneOlderThan(retentionDays)
  const totalPruned = pruneResult.dispatches + pruneResult.entities + pruneResult.cron_executions + pruneResult.links
  if (totalPruned > 0) {
    logger.info("retention prune", { days: retentionDays, pruned: pruneResult })
  }
  const retentionInterval = setInterval(
    () => {
      const days = store.getRetentionDays() ?? DEFAULT_RETENTION_DAYS
      const r = store.pruneOlderThan(days)
      const total = r.dispatches + r.entities + r.cron_executions + r.links
      if (total > 0) {
        logger.info("retention prune", { days, pruned: r })
      }
    },
    24 * 60 * 60 * 1000,
  )

  const cronTriggers = triggers.filter((t) => t.source === "cron")
  const defaultCronTrigger = cronTriggers[0] ?? null
  const defaultAgent = defaultCronTrigger?.agent ?? triggers[0]?.agent ?? "jared"

  const cronScheduler = makeCronScheduler({
    store,
    pipeline,
    defaultAgent,
    cronTrigger: defaultCronTrigger,
  })
  cronScheduler.start()
  logger.info("cron scheduler started")

  const { handlers, auth } = createHandlers({
    triggers,
    githubApp,
  })

  // Resolve bot identity from the GitHub App. The app's bot login is
  // "<slug>[bot]" and the installation token is set as GH_TOKEN so the
  // agent's gh CLI calls are attributed to the app.
  let botLogin: string | null = null
  let tokenRefreshTimer: ReturnType<typeof setInterval> | null = null

  try {
    const { botLogin: resolvedLogin, tokenRefreshTimer: refreshTimer } = await initAppIdentity(auth)
    botLogin = resolvedLogin
    tokenRefreshTimer = refreshTimer
    logger.info("GitHub App identity resolved", { login: botLogin })
    Sentry.setTag("bot.login", botLogin)
  } catch (_err) {
    // Fall back to GH_TOKEN-based identity if App identity fails
    botLogin = await resolveBotLogin()
    if (botLogin) {
      logger.warn("GitHub App identity failed, using GH_TOKEN identity", { login: botLogin })
      Sentry.setTag("bot.login", botLogin)
    } else {
      logger.warn("could not resolve bot identity -- self-loop guard degraded")
    }
  }

  // Re-normalize triggers with the resolved bot login for ignore_authors
  const normalizedTriggers = (cfg.triggers ?? []).map((t) => normalizeTrigger(t, botLogin))

  const handlerContext: HandlerContext = {
    pipeline,
    dedup,
    store,
    botLogin,
  }

  const app = createApp({
    handlers,
    handlerContext,
    store,
    apiToken,
    cronScheduler,
  })

  const server = Bun.serve({
    port,
    hostname: "0.0.0.0",
    fetch: app.fetch,
  })

  const triggerCount = normalizedTriggers.filter((t) => t.source === "github_app").length
  logger.info("listening", {
    url: `http://0.0.0.0:${server.port}`,
    triggers: {
      github_app: triggerCount,
      cron: cronTriggers.length,
    },
  })

  return {
    app,
    server,
    store,
    pipeline,
    cronScheduler,
    drainCounter,
    dedup,
    botLogin,
    defaultAgent,
    client: opts.client,
    retentionInterval,
    auth,
    tokenRefreshTimer,
  }
}

// Initialize the GitHub App identity: resolve the default installation,
// acquire an installation token, set it as GH_TOKEN, configure git
// identity, and start a refresh loop.
async function initAppIdentity(auth: GitHubAppAuth): Promise<{
  botLogin: string
  tokenRefreshTimer: ReturnType<typeof setInterval>
}> {
  const slug = await auth.getAppSlug()
  const botLogin = `${slug}[bot]`

  // Discover the default installation (first one found)
  const installationId = await auth.getDefaultInstallationId()

  // Acquire initial token and set as GH_TOKEN
  const token = await auth.getInstallationToken(installationId)
  process.env.GH_TOKEN = token

  // Configure git identity for the App bot account.
  // GitHub App bots use the pattern: <bot-id>+<slug>[bot]@users.noreply.github.com
  await configureGitIdentity(botLogin)

  // Refresh the token every 45 minutes (tokens expire after 60 min)
  const REFRESH_INTERVAL_MS = 45 * 60 * 1000
  const tokenRefreshTimer = setInterval(async () => {
    try {
      const freshToken = await auth.getInstallationToken(installationId)
      process.env.GH_TOKEN = freshToken
      Sentry.logger.info("github_app.token_refreshed", { installation_id: installationId })
    } catch (err) {
      Sentry.logger.error("github_app.token_refresh_failed", {
        installation_id: installationId,
        error: String(err),
      })
    }
  }, REFRESH_INTERVAL_MS)
  tokenRefreshTimer.unref?.()

  logger.info("GitHub App token refresh loop started", {
    installation_id: installationId,
    interval_ms: REFRESH_INTERVAL_MS,
  })

  return { botLogin, tokenRefreshTimer }
}

// Configure git author identity for the bot account.
async function configureGitIdentity(botLogin: string): Promise<void> {
  const devDir = join(homedir(), "dev")

  // Resolve the bot's numeric ID via the GitHub API for the noreply email
  try {
    const res = await fetch(`https://api.github.com/users/${encodeURIComponent(botLogin)}`, {
      headers: {
        Authorization: `token ${process.env.GH_TOKEN}`,
        Accept: "application/vnd.github+json",
      },
    })
    if (res.ok) {
      const data = (await res.json()) as { id: number; login: string }
      const email = `${data.id}+${data.login}@users.noreply.github.com`

      // Set git identity globally and for the dev directory
      const gitConfig = async (scope: string[], name: string, value: string) => {
        const proc = Bun.spawn(["git", ...scope, "config", name, value], {
          stdout: "ignore",
          stderr: "ignore",
        })
        await proc.exited
      }

      await gitConfig([], "user.name", botLogin)
      await gitConfig([], "user.email", email)
      await gitConfig(["-C", devDir], "user.name", botLogin)
      await gitConfig(["-C", devDir], "user.email", email)

      logger.info("git identity configured", { name: botLogin, email })
    }
  } catch {
    // Non-fatal: git identity may already be set by the entrypoint
    logger.warn("failed to configure git identity from GitHub API")
  }
}

export async function gracefulShutdown(
  result: Pick<
    BootstrapResult,
    "server" | "drainCounter" | "cronScheduler" | "store" | "retentionInterval" | "tokenRefreshTimer"
  >,
  sig: string,
): Promise<void> {
  clearInterval(result.retentionInterval)
  if (result.tokenRefreshTimer) clearInterval(result.tokenRefreshTimer)
  logger.info("shutting down", { signal: sig, inFlight: result.drainCounter.inFlight() })
  result.server.stop(true)
  const drainTimeoutMs = 25_000
  try {
    await Promise.race([
      result.drainCounter.wait(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("drain timeout")), drainTimeoutMs)),
    ])
    logger.info("all dispatches drained")
  } catch {
    logger.warn("drain timeout", { timeoutMs: drainTimeoutMs, inFlight: result.drainCounter.inFlight() })
  }
  result.cronScheduler.stop()
  result.store.close()
  await Sentry.close(2000)
}
