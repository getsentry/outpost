// Shared types for the outpost worker control plane.

export type TriggerSource = "github_app" | "cron"

export type Trigger = {
  name: string
  source?: TriggerSource
  event: string | string[]
  action?: string | null
  agent: string
  prompt_template: string
  cwd?: string | null
  enabled?: boolean
  ignore_authors?: string[]
}

export type NormalizedTrigger = Omit<Trigger, "action" | "enabled" | "source" | "event"> & {
  source: TriggerSource
  action: string | null
  enabled: boolean
  events: string[]
}

export type SkippedDispatch = {
  name: string
  reason: string
}

export type GithubAppConfig = {
  app_id: string
  private_key: string
  webhook_secret: string
}

// Cloudflare Worker environment bindings.
export type Env = {
  // D1 database binding
  DB: D1Database
  // Durable Object namespace for sandbox containers
  SANDBOX: DurableObjectNamespace
  // Worker variables (from wrangler.jsonc vars + secrets)
  MAX_CONCURRENT: string
  TIMEOUT_MS: string
  BATCH_WINDOW_MS: string
  DEFAULT_AGENT: string
  // Secrets (set via `wrangler secret put`)
  GITHUB_APP_ID: string
  GITHUB_APP_PRIVATE_KEY: string
  GITHUB_APP_WEBHOOK_SECRET: string
  OPENTOWER_API_TOKEN: string
  SENTRY_DSN?: string
  OPENTOWER_CORS_ORIGIN?: string
}

