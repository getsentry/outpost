// Config file loading + per-trigger normalization.

import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { formatError, logger } from "./logger"
import type { GithubAppConfig, NormalizedTrigger, Trigger, WebhookConfig } from "./types"

// Config file names in priority order. The first file found wins.
// "opentower.config.json" is the current name; "webhooks.json" is the
// legacy name used by opentower <=0.4.0. Supporting both avoids a
// breaking change for existing deployments.
const CONFIG_FILENAMES = ["opentower.config.json", "webhooks.json"]

// Read opentower config. Resolution order:
//   1. OPENTOWER_CONFIG env var (explicit path)
//   2. WEBHOOKS_CONFIG env var (legacy explicit path)
//   3. First existing file from CONFIG_FILENAMES in ~/.config/opencode/
// Missing file = no triggers.
export async function readWebhookConfig(): Promise<WebhookConfig> {
  const path = configPath()
  if (!existsSync(path)) return {}
  try {
    const raw = await Bun.file(path).text()
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object") return {}
    return parsed as WebhookConfig
  } catch (err) {
    logger.error("failed to parse config", { path, error: formatError(err) })
    return {}
  }
}

export function configPath(): string {
  // Explicit env var overrides take priority.
  if (process.env.OPENTOWER_CONFIG) return process.env.OPENTOWER_CONFIG
  if (process.env.WEBHOOKS_CONFIG) return process.env.WEBHOOKS_CONFIG

  // Search for config files by name in the default directory.
  const configDir = join(homedir(), ".config", "opencode")
  for (const filename of CONFIG_FILENAMES) {
    const candidate = join(configDir, filename)
    if (existsSync(candidate)) return candidate
  }

  // Fall back to the preferred name even if it doesn't exist yet
  // (readWebhookConfig handles the missing-file case).
  return join(configDir, CONFIG_FILENAMES[0])
}

// Normalize a trigger's ignore_authors:
//  - "$BOT_LOGIN" is substituted with the resolved bot login (dropped
//    silently if unresolved).
//  - Dedup is case-insensitive.
export function normalizeTrigger(t: Trigger, botLogin: string | null): NormalizedTrigger {
  const merged: string[] = []
  const seen = new Set<string>()
  for (const raw of t.ignore_authors ?? []) {
    const expanded = raw === "$BOT_LOGIN" ? botLogin : raw
    if (!expanded) continue
    const k = expanded.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    merged.push(expanded)
  }
  // Normalize event to always be an array so matchers can stay simple.
  const events = Array.isArray(t.event) ? t.event : [t.event]
  const { event: _drop, ...rest } = t
  return {
    ...rest,
    source: t.source ?? "github_app",
    action: t.action ?? null,
    enabled: t.enabled !== false,
    events,
    ignore_authors: merged.length > 0 ? merged : undefined,
  }
}

// Resolve GitHub App config from environment variables.
// Returns null if any required variable is missing.
export function resolveGithubAppFromEnv(): GithubAppConfig | null {
  const appId = process.env.GITHUB_APP_ID
  const rawKey = process.env.GITHUB_APP_PRIVATE_KEY
  const webhookSecret = process.env.GITHUB_APP_WEBHOOK_SECRET
  if (!appId || !rawKey || !webhookSecret) return null
  // PEM keys stored in env vars often have literal "\n" instead of
  // real newlines. Normalize so crypto.createSign can parse the key.
  const privateKey = rawKey.replace(/\\n/g, "\n")
  return { app_id: appId, private_key: privateKey, webhook_secret: webhookSecret }
}
