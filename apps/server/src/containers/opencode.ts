// OpenCode Container — runs an OpenCode instance per entity key.
//
// Each container is keyed by entity key (e.g., "owner/repo#42").
// The container runs `opencode serve` and processes webhook events
// as prompts via the OpenCode SDK/HTTP API.
//
// Outbound HTTP from the container to "worker.internal" is intercepted
// by the Worker to serve configuration, session data, and token refresh.

import { Container } from "@cloudflare/containers"
import { createLogger, formatError } from "@jared/utils"
import { desc, eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"
import * as dbSchema from "@/db/schema"
import { createGitHubApp } from "@/lib/github/app"

const logger = createLogger({ namespace: "container" })

/**
 * Read LLM provider API keys from the Worker env bindings.
 *
 * TODO: Replace with a real token service call. The actual service
 * will issue short-lived tokens scoped to this container's session.
 * For now, reads from Worker env vars as a placeholder.
 */
function getLLMTokens(env: Record<string, unknown>): {
  anthropicApiKey: string
  openaiApiKey: string
} {
  return {
    anthropicApiKey: (env.ANTHROPIC_API_KEY as string) ?? "",
    openaiApiKey: (env.OPENAI_API_KEY as string) ?? "",
  }
}

export class OpenCodeContainer extends Container {
  defaultPort = 4096
  sleepAfter = "15m"
  enableInternet = true
  pingEndpoint = "/global/health"

  override async onStart() {
    logger.info("container started")
  }

  override async onStop(opts: { exitCode: number; reason: string }) {
    logger.info({ exit_code: opts.exitCode, reason: opts.reason }, "container stopped")
  }

  override async onError(error: unknown) {
    logger.error({ error: formatError(error) }, "container error")
  }
}

// Outbound interception — must be assigned as a static property outside
// the class body per Cloudflare's Container class convention.
// See: https://developers.cloudflare.com/containers/platform-details/outbound-traffic/
OpenCodeContainer.outboundByHost = {
  "worker.internal": async (request: Request, env: Record<string, unknown>) => {
    const url = new URL(request.url)
    const db = drizzle(env.DB as D1Database, { schema: dbSchema })

    // GET /config?entity=owner/repo#42
    // Returns: repo info, installation token, bot identity, LLM keys, session data.
    // Used by setup.ts to configure the container environment before OpenCode starts.
    if (url.pathname === "/config" && request.method === "GET") {
      const entityKey = url.searchParams.get("entity")
      if (!entityKey) {
        return Response.json({ error: "entity parameter required" }, { status: 400 })
      }

      try {
        // Parse repo from entity key (owner/repo#N -> owner/repo)
        const hashIdx = entityKey.lastIndexOf("#")
        const repo = hashIdx > 0 ? entityKey.slice(0, hashIdx) : entityKey

        // Get saved session data if it exists
        const savedSession = await db
          .select()
          .from(dbSchema.agentSessions)
          .where(eq(dbSchema.agentSessions.entityKey, entityKey))
          .limit(1)

        // Resolve GitHub App identity and installation token
        let installationToken = ""
        let botLogin = ""
        let botEmail = ""

        const appId = env.GITHUB_APP_ID as string
        const privateKey = env.GITHUB_APP_PRIVATE_KEY as string
        const webhookSecret = env.GITHUB_APP_WEBHOOK_SECRET as string

        if (appId && privateKey) {
          try {
            const app = createGitHubApp({
              appId,
              privateKey,
              webhookSecret,
            })

            botLogin = await app.getBotLogin()
            botEmail = `${botLogin}@users.noreply.github.com`

            // Get installation token — look up from the most recent event for this entity
            const recentEvent = await db
              .select({ installationId: dbSchema.webhookEvents.installationId })
              .from(dbSchema.webhookEvents)
              .where(eq(dbSchema.webhookEvents.entityKey, entityKey))
              .orderBy(desc(dbSchema.webhookEvents.createdAt))
              .limit(1)

            const installationId = recentEvent[0]?.installationId ?? null
            if (installationId) {
              const octokit = app.getInstallationOctokit(installationId)
              const auth = (await octokit.auth({
                type: "installation",
              })) as { token: string }
              installationToken = auth.token
            }
          } catch (err) {
            logger.warn({ error: formatError(err) }, "failed to resolve GitHub App identity")
          }
        }

        // Read LLM provider tokens from env
        const llmTokens = getLLMTokens(env)

        const config = {
          entityKey,
          repo,
          repoUrl: `https://github.com/${repo}`,
          installationToken,
          botLogin,
          botEmail,
          sentryDsn: (env.SENTRY_DSN as string) ?? "",
          anthropicApiKey: llmTokens.anthropicApiKey,
          openaiApiKey: llmTokens.openaiApiKey,
          sessionData: savedSession[0]?.sessionData ?? null,
        }

        return Response.json(config)
      } catch (err) {
        logger.error({ error: formatError(err) }, "config handler failed")
        return Response.json({ error: "internal error" }, { status: 500 })
      }
    }

    // POST /sessions/save
    // Body: { entityKey, sessionId, sessionData }
    // Saves the OpenCode session export JSON to D1.
    if (url.pathname === "/sessions/save" && request.method === "POST") {
      try {
        const body = (await request.json()) as {
          entityKey: string
          sessionId?: string
          sessionData: string
        }

        const now = new Date()
        await db
          .insert(dbSchema.agentSessions)
          .values({
            entityKey: body.entityKey,
            sessionId: body.sessionId ?? null,
            sessionData: body.sessionData,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: dbSchema.agentSessions.entityKey,
            set: {
              sessionId: body.sessionId ?? null,
              sessionData: body.sessionData,
              updatedAt: now,
            },
          })

        return Response.json({ ok: true })
      } catch (err) {
        logger.error({ error: formatError(err) }, "session save handler failed")
        return Response.json({ error: "internal error" }, { status: 500 })
      }
    }

    return new Response("Not Found", { status: 404 })
  },
}
