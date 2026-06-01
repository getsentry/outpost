// GitHub App webhook handler for the Cloudflare Worker control plane.
// Receives webhook events, verifies signatures, matches triggers,
// and dispatches to sandbox containers.

import type { GitHubAppAuth } from "../auth"
import { dispatchNoAffinity, dispatchToSandbox } from "../dispatch"
import { createGitHubFetcher } from "../github-api"
import { verifyGithubSignature } from "../hmac"
import { formatError, logger } from "../logger"
import { evaluateAndExtract } from "../matchers"
import type { LifecycleStore } from "../storage"
import { lookupString } from "../template"
import type { Env, NormalizedTrigger } from "../types"

const MAX_BODY_BYTES = 25 * 1024 * 1024

export async function handleGithubAppWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  store: LifecycleStore,
  auth: GitHubAppAuth,
  triggers: NormalizedTrigger[],
  botLogin: string | null,
): Promise<Response> {
  const webhookSecret = env.GITHUB_APP_WEBHOOK_SECRET
  if (!webhookSecret) {
    return Response.json({ error: "no GitHub App webhook secret configured" }, { status: 503 })
  }

  const event = request.headers.get("x-github-event")
  const deliveryId = request.headers.get("x-github-delivery")
  if (!event || !deliveryId) {
    return Response.json(
      { error: "missing required headers (x-github-event, x-github-delivery)" },
      { status: 400 },
    )
  }

  // Size check.
  const contentLength = Number(request.headers.get("content-length") ?? "0")
  if (contentLength > MAX_BODY_BYTES) {
    return Response.json({ error: "payload too large" }, { status: 413 })
  }

  const rawBody = await request.text()
  if (rawBody.length > MAX_BODY_BYTES) {
    return Response.json({ error: "payload too large" }, { status: 413 })
  }

  // HMAC signature verification.
  const signature = request.headers.get("x-hub-signature-256")
  const valid = await verifyGithubSignature(rawBody, signature, webhookSecret)
  if (!valid) {
    return Response.json({ error: "invalid signature" }, { status: 401 })
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

  // Dedup via D1.
  const isDuplicate = await store.checkDedup(deliveryId)
  if (isDuplicate) {
    return Response.json({ ok: true, delivery_id: deliveryId, duplicate: true, dispatched: [] })
  }

  // Get installation token for API access.
  const installationId = (payload as { installation?: { id?: number } })?.installation?.id
  let githubFetcher = null
  let ghToken = ""
  if (installationId) {
    try {
      ghToken = await auth.getInstallationToken(installationId)
      githubFetcher = createGitHubFetcher(ghToken)
    } catch (err) {
      logger.error("github app token failed", {
        installation_id: installationId,
        delivery_id: deliveryId,
        error: formatError(err),
      })
    }
  }

  // Fall back to default installation token if per-installation token
  // failed or no installation ID was present in the payload.
  if (!githubFetcher) {
    try {
      const defaultId = await auth.getDefaultInstallationId()
      ghToken = await auth.getInstallationToken(defaultId)
      githubFetcher = createGitHubFetcher(ghToken)
    } catch {
      // Non-fatal: entity enrichment will be degraded.
    }
  }

  // Resolve bot login from the App.
  let resolvedBotLogin = botLogin
  if (!resolvedBotLogin) {
    try {
      const slug = await auth.getAppSlug()
      resolvedBotLogin = `${slug}[bot]`
    } catch {
      // Non-fatal.
    }
  }

  logger.info("webhook received", {
    source: "github_app",
    event,
    action: action ?? "",
    delivery_id: deliveryId,
    sender: lookupString(payload, "sender.login") ?? "",
    repo: lookupString(payload, "repository.full_name") ?? "",
    installation_id: installationId ?? "",
  })

  // Match triggers and extract dispatch targets.
  const { targets, skipped } = await evaluateAndExtract({
    triggers,
    event,
    action,
    payload,
    sender: lookupString(payload, "sender.login"),
    botLogin: resolvedBotLogin,
    deliveryId,
    templateContext: {
      event,
      action,
      delivery_id: deliveryId,
      payload,
      installation_id: installationId,
      bot_login: resolvedBotLogin ?? "",
    },
    githubFetcher,
  })

  // Dispatch to containers. Wrap in ctx.waitUntil so the Worker runtime
  // keeps the isolate alive until dispatches complete, even after the
  // webhook response is sent.
  const dispatched: string[] = []
  const timeoutMs = Number(env.TIMEOUT_MS) || 1_800_000
  for (const target of targets) {
    const dispatchPromise = target.entityKey
      ? dispatchToSandbox({
          env,
          store,
          entityKey: target.entityKey,
          trigger: target.trigger,
          prompt: target.prompt,
          deliveryId: target.deliveryId,
          matchedEvent: target.matchedEvent,
          ghToken,
          timeoutMs,
        })
      : dispatchNoAffinity({
          env,
          store,
          trigger: target.trigger,
          prompt: target.prompt,
          deliveryId: target.deliveryId,
          matchedEvent: target.matchedEvent,
          ghToken,
          timeoutMs,
        })

    ctx.waitUntil(dispatchPromise)
    dispatched.push(target.trigger.name)
  }

  return Response.json({
    ok: true,
    delivery_id: deliveryId,
    event,
    action,
    duplicate: false,
    dispatched,
    ...(skipped.length > 0 ? { skipped } : {}),
  })
}
