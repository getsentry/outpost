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
import { type EntityResolver, createEntityResolver } from "./entity-resolver"
import { type AppEnv, createApp } from "./handler"
import { createHandlers } from "./handlers/registry"
import type { AgentClient, HandlerContext } from "./interfaces"
import { logger } from "./logger"
import { type Pipeline, makePipeline } from "./pipeline"
import { type DrainCounter, makeDrainCounter, makeSemaphore } from "./semaphore"
import { type LifecycleStore, openLifecycleStore } from "./storage"

export type BootstrapResult = {
  app: Hono<AppEnv>
  server: ReturnType<typeof Bun.serve>
  store: LifecycleStore
  pipeline: Pipeline
  cronScheduler: CronScheduler
  drainCounter: DrainCounter
  dedup: Dedup
  botLogin: string | null
  entityResolver: EntityResolver | null
  defaultAgent: string
  client: AgentClient
  retentionInterval: ReturnType<typeof setInterval>
}

export type BootstrapOptions = {
  client: AgentClient
  defaultCwd: string
}

export async function bootstrap(opts: BootstrapOptions): Promise<BootstrapResult | null> {
  const cfg = await readWebhookConfig()
  logger.info("config loaded", { path: configPath() })

  const port = cfg.port ?? Number(process.env.WEBHOOK_PORT ?? "5050")
  const secret = cfg.secret ?? process.env.GITHUB_WEBHOOK_SECRET ?? ""
  const emailSecret = cfg.email_secret ?? process.env.EMAIL_WEBHOOK_SECRET ?? ""
  const timeoutMs = cfg.timeout_ms ?? 1_800_000
  const maxConcurrent = Math.max(1, cfg.max_concurrent ?? 2)
  const defaultCwd = cfg.default_cwd ?? opts.defaultCwd

  const botLogin = await resolveBotLogin()
  if (botLogin) {
    logger.info("bot identity resolved", { login: botLogin })
    Sentry.setTag("bot.login", botLogin)
  } else {
    logger.warn(
      "could not resolve bot identity via 'gh api user' -- $BOT_LOGIN in ignore_authors will not be substituted",
    )
  }

  const triggers = (cfg.triggers ?? []).map((t) => normalizeTrigger(t, botLogin))
  if (triggers.length === 0) {
    logger.info("no triggers configured -- listener disabled", { path: configPath() })
    return null
  }

  const githubTriggerCount = triggers.filter((t) => t.source === "github_webhook").length
  const emailTriggerCount = triggers.filter((t) => t.source === "email").length
  const githubAppTriggerCount = triggers.filter((t) => t.source === "github_app").length

  if (githubTriggerCount > 0 && !secret) {
    logger.warn("no GitHub HMAC secret configured -- /webhooks/github will reject with 503")
  }
  if (emailTriggerCount > 0 && !emailSecret) {
    logger.warn("no email HMAC secret configured -- /webhooks/email will reject with 503")
  }

  const githubApp = cfg.github_app ?? resolveGithubAppFromEnv()
  if (githubAppTriggerCount > 0 && !githubApp) {
    logger.warn(
      "github_app triggers configured but no GitHub App credentials found -- /webhooks/github-app will not be registered",
    )
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

  const entityResolver = createEntityResolver()
  if (entityResolver) {
    logger.info("AI entity resolver enabled (ANTHROPIC_API_KEY set)")
  } else if (emailTriggerCount > 0) {
    logger.warn("ANTHROPIC_API_KEY not set -- AI entity resolution for emails disabled")
  }

  const apiToken = process.env.OPENTOWER_API_TOKEN ?? ""
  if (!apiToken) {
    logger.warn("OPENTOWER_API_TOKEN not set -- /api/* endpoints will reject with 503")
  }

  // Data retention: prune old dispatches/entities on startup and every 24h.
  const DEFAULT_RETENTION_DAYS = 30
  const retentionDays = cfg.retention_days ?? store.getRetentionDays() ?? DEFAULT_RETENTION_DAYS
  // Persist the default so the dashboard API can read it.
  if (!store.getRetentionDays()) store.setRetentionDays(retentionDays)
  const pruneResult = store.pruneOlderThan(retentionDays)
  const totalPruned = pruneResult.dispatches + pruneResult.entities + pruneResult.cronExecutions
  if (totalPruned > 0) {
    logger.info("retention prune", { days: retentionDays, pruned: pruneResult })
  }
  const retentionInterval = setInterval(
    () => {
      const days = store.getRetentionDays() ?? DEFAULT_RETENTION_DAYS
      const r = store.pruneOlderThan(days)
      const total = r.dispatches + r.entities + r.cronExecutions
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

  const handlers = createHandlers({
    secret,
    emailSecret,
    triggers,
    githubApp,
  })

  const handlerContext: HandlerContext = {
    pipeline,
    dedup,
    store,
    botLogin,
    entityResolver,
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

  const cronTriggerCount = cronTriggers.length
  logger.info("listening", {
    url: `http://0.0.0.0:${server.port}`,
    triggers: {
      github: githubTriggerCount,
      github_app: githubAppTriggerCount,
      email: emailTriggerCount,
      cron: cronTriggerCount,
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
    entityResolver,
    defaultAgent,
    client: opts.client,
    retentionInterval,
  }
}

export async function gracefulShutdown(
  result: Pick<BootstrapResult, "server" | "drainCounter" | "cronScheduler" | "store" | "retentionInterval">,
  sig: string,
): Promise<void> {
  clearInterval(result.retentionInterval)
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
