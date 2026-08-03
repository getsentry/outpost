import type { Logger } from "@jared/utils"
import type { DrizzleD1Database } from "drizzle-orm/d1"
import type * as dbSchema from "@/db/schema"
import type { Sandbox } from "@/lib/containers/sandbox"
import type { createAuth } from "@/utils"

export type BaseEnvBindings = {
  Bindings: {
    CF_VERSION_METADATA: { id: string }
    DB: D1Database
    RATE_LIMITER: RateLimit
    // The following environment variables are defined in the .dev.vars file
    // This is just for development purposes
    ENV: "development" | "production"
    BETTER_AUTH_SECRET: string
    APP_URL: string
    GOOGLE_CLIENT_ID: string
    GOOGLE_CLIENT_SECRET: string
    SENTRY_DSN?: string
    // Agent API keys - For local testing
    ANTHROPIC_API_KEY?: string
    OPENAI_API_KEY?: string
    OPENROUTER_API_KEY?: string
    // GitHub App credentials for webhook handling
    GITHUB_APP_ID: string
    GITHUB_APP_PRIVATE_KEY: string
    GITHUB_APP_WEBHOOK_SECRET: string
    // Sentry internal integration (for assigning Sentry issues to the agent)
    SENTRY_INTEGRATION_CLIENT_SECRET?: string
    SENTRY_INTEGRATION_TOKEN?: string
    // Cloudflare Sandbox Durable Object binding (thin Linux sandbox for Flue)
    Sandbox: DurableObjectNamespace<Sandbox>
    /**
     * Phase 2 flag: when "1"/"true", agent brain runs as a Flue Durable Object
     * and the container is a thin sandbox (no in-container Flue/Lore process).
     * Must stay paired with containers[].image (Dockerfile.phase1 when 0,
     * Dockerfile when 1).
     */
    FLUE_NATIVE?: string
    /** Standalone Lore gateway base URL (Phase 2). */
    LORE_GATEWAY_URL?: string
    /**
     * Shared secret for Worker↔container session ingest and Worker-internal
     * Flue history pulls. Falls back to BETTER_AUTH_SECRET when unset.
     */
    FLUE_INTERNAL_TOKEN?: string
    /** Flue-generated Jared agent DO binding (Phase 2). */
    FLUE_JARED_AGENT?: DurableObjectNamespace
  }
  Variables: {
    logger: Logger
  }
}

export type BaseEnv = BaseEnvBindings & {
  Variables: BaseEnvBindings["Variables"] & {
    db: DrizzleD1Database<typeof dbSchema>
    auth: ReturnType<typeof createAuth>
  }
}
