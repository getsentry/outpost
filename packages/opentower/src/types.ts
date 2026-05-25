// Shared types for the opentower plugin.

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

export type WebhookConfig = {
  port?: number
  timeout_ms?: number
  max_concurrent?: number
  batch_window_ms?: number
  default_cwd?: string
  triggers?: Trigger[]

  // Data retention in days. Dispatches and entities older than this are
  // pruned on startup and then periodically. Defaults to 30 days.
  retention_days?: number

  // GitHub App configuration (required for webhook handling).
  github_app?: GithubAppConfig
}

export type GithubAppConfig = {
  app_id: string
  private_key: string
  webhook_secret: string
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
