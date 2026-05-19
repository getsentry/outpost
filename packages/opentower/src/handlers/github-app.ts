// WebhookHandler for GitHub App webhooks.
// Uses GitHub App authentication (JWT + installation tokens) instead of
// a personal access token. The webhook payload format is identical to
// org/repo webhooks, but includes an `installation.id` field that
// identifies which installation sent the event.

import * as Sentry from "@sentry/bun"
import type { Hono } from "hono"
import { createGitHubFetcher } from "../github-api"
import type { GitHubAppAuth } from "../github-app-auth"
import { verifyGithubSignature } from "../hmac"
import { readBodyBytes } from "../http"
import type { HandlerContext, WebhookHandler } from "../interfaces"
import { evaluateAndDispatch } from "../matchers"
import { lookupString } from "../template"
import type { NormalizedTrigger } from "../types"

export type GithubAppHandlerOptions = {
  webhookSecret: string
  triggers: NormalizedTrigger[]
  auth: GitHubAppAuth
}

export function createGithubAppHandler(opts: GithubAppHandlerOptions): WebhookHandler {
  const { webhookSecret, triggers, auth } = opts

  // GitHub App bot login is "<slug>[bot]". Resolved lazily on first
  // request via a shared promise to avoid duplicate API calls from
  // concurrent requests. Falls back to context.botLogin on failure.
  let appBotLoginPromise: Promise<string | null> | null = null

  function resolveAppBotLogin(fallback: string | null): Promise<string | null> {
    if (!appBotLoginPromise) {
      appBotLoginPromise = auth
        .getAppSlug()
        .then((slug) => {
          const login = `${slug}[bot]`
          Sentry.logger.info("github_app.bot_identity", { bot_login: login })
          return login
        })
        .catch(() => {
          // Clear the cached promise so the next request retries.
          // Transient failures (network, rate-limit) shouldn't
          // permanently disable the app's self-loop guard.
          appBotLoginPromise = null
          return fallback
        })
    }
    return appBotLoginPromise
  }

  return {
    source: "github_app",

    register(app: Hono, context: HandlerContext) {
      app.post("/webhooks/github-app", async (c) => {
        if (!webhookSecret) {
          return c.json({ error: "no GitHub App webhook secret configured" }, 503)
        }

        const event = c.req.header("x-github-event")
        const deliveryId = c.req.header("x-github-delivery")
        if (!event || !deliveryId) {
          return c.json({ error: "missing required headers (x-github-event, x-github-delivery)" }, 400)
        }

        const body = await readBodyBytes(c.req.raw)
        if (!body.ok) return body.response

        const rawBody = new TextDecoder("utf-8").decode(body.bytes)
        const signature = c.req.header("x-hub-signature-256") ?? null
        if (!verifyGithubSignature(rawBody, signature, webhookSecret)) {
          return c.json({ error: "invalid signature" }, 401)
        }

        let payload: unknown = {}
        let action: string | null = null
        try {
          payload = JSON.parse(rawBody)
          const a = (payload as { action?: unknown }).action
          if (typeof a === "string") action = a
        } catch {
          // Not JSON -- dispatch with empty payload.
        }

        if (context.dedup.seen(deliveryId)) {
          return c.json({ ok: true, delivery_id: deliveryId, duplicate: true, dispatched: [] })
        }

        // Acquire an installation token for entity enrichment (fetching PR
        // bodies, resolving branches). The token is used for API calls but
        // NOT injected into the payload or template context.
        const installationId = (payload as { installation?: { id?: number } })?.installation?.id
        let githubFetcher = null
        if (installationId) {
          try {
            const token = await auth.getInstallationToken(installationId)
            githubFetcher = createGitHubFetcher(token)
            Sentry.logger.info("github_app.token_acquired", {
              installation_id: installationId,
              delivery_id: deliveryId,
            })
          } catch (err) {
            Sentry.logger.error("github_app.token_failed", {
              installation_id: installationId,
              delivery_id: deliveryId,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }

        const appBotLogin = await resolveAppBotLogin(context.botLogin)

        Sentry.logger.info("webhook.received", {
          source: "github_app",
          event,
          action: action ?? "",
          delivery_id: deliveryId,
          sender: lookupString(payload, "sender.login") ?? "",
          repo: lookupString(payload, "repository.full_name") ?? "",
          installation_id: installationId ?? "",
        })

        const { dispatched, skipped } = await evaluateAndDispatch({
          triggers,
          event,
          action,
          payload,
          sender: lookupString(payload, "sender.login"),
          botLogin: appBotLogin ?? context.botLogin,
          deliveryId,
          templateContext: {
            event,
            action,
            delivery_id: deliveryId,
            payload,
            installation_id: installationId,
          },
          pipeline: context.pipeline,
          githubFetcher,
        })

        return c.json({
          ok: true,
          delivery_id: deliveryId,
          event,
          action,
          duplicate: false,
          dispatched,
          ...(skipped.length > 0 ? { skipped } : {}),
        })
      })
    },
  }
}
