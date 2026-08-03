// Sentry webhook handler.
//
// Receives webhook events from a Sentry internal integration when issues
// are assigned to the #special-projects team. Fetches full error context
// (stack trace, breadcrumbs, tags) and dispatches a fix prompt to the
// Flue agent (Durable Object or in-container).
//
// Flow:
//   1. Issue assigned to team #special-projects → webhook fires
//   2. Verify HMAC-SHA256 signature using client secret
//   3. Fetch full issue details (latest event, stack trace)
//   4. Determine GitHub repo from Sentry project
//   5. Format prompt with error context and dispatch to container

import { getSandbox } from "@cloudflare/sandbox"
import { formatError } from "@jared/utils"
import * as Sentry from "@sentry/cloudflare"
import { Hono } from "hono"
import { dispatchPrompt, ensureSandboxReady, saveInitialSession } from "@/lib/containers/dispatch"
import type { BaseEnv } from "@/types"

// The Sentry team whose assignment triggers the agent
const TRIGGER_TEAM = "special-projects"

// Sentry API base URL
const SENTRY_API = "https://sentry.io/api/0"

/**
 * Verify the Sentry webhook signature (HMAC-SHA256).
 */
async function verifySentrySignature(body: string, signature: string, secret: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ])
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body))
  const expected = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
  // Constant-time comparison to prevent timing side-channel attacks
  if (expected.length !== signature.length) return false
  const a = encoder.encode(expected)
  const b2 = encoder.encode(signature)
  let result = 0
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b2[i]
  }
  return result === 0
}

/**
 * Fetch full issue details from the Sentry API including the latest event
 * with stack trace, breadcrumbs, and tags.
 */
async function fetchSentryIssueContext(
  issueId: string,
  token: string,
): Promise<{
  issue: Record<string, unknown>
  latestEvent: Record<string, unknown> | null
}> {
  const headers = { Authorization: `Bearer ${token}` }

  // Fetch issue details
  const issueRes = await fetch(`${SENTRY_API}/issues/${issueId}/`, { headers })
  if (!issueRes.ok) throw new Error(`Failed to fetch issue ${issueId}: ${issueRes.status}`)
  const issue = (await issueRes.json()) as Record<string, unknown>

  // Fetch latest event for the issue (includes stack trace, breadcrumbs)
  let latestEvent: Record<string, unknown> | null = null
  try {
    const eventRes = await fetch(`${SENTRY_API}/issues/${issueId}/events/latest/`, { headers })
    if (eventRes.ok) {
      latestEvent = (await eventRes.json()) as Record<string, unknown>
    }
  } catch {
    // Best effort — issue details alone are still useful
  }

  return { issue, latestEvent }
}

/**
 * Extract a readable stack trace from a Sentry event.
 */
function extractStackTrace(event: Record<string, unknown>): string {
  const entries = event.entries as Array<{ type: string; data: Record<string, unknown> }> | undefined
  if (!entries) return ""

  const exceptionEntry = entries.find((e) => e.type === "exception")
  if (!exceptionEntry) return ""

  const values = (exceptionEntry.data.values as Array<Record<string, unknown>>) ?? []
  const lines: string[] = []

  for (const exc of values) {
    const type = (exc.type as string) ?? "Error"
    const value = (exc.value as string) ?? ""
    lines.push(`${type}: ${value}`)

    const stacktrace = exc.stacktrace as { frames?: Array<Record<string, unknown>> } | undefined
    if (stacktrace?.frames) {
      // Frames are in reverse order (most recent last), show most recent first
      const frames = [...stacktrace.frames].reverse()
      for (const frame of frames.slice(0, 15)) {
        const file = (frame.filename as string) ?? (frame.absPath as string) ?? "?"
        const line = frame.lineNo ?? "?"
        const col = frame.colNo ?? ""
        const fn = (frame.function as string) ?? "(anonymous)"
        const inApp = frame.inApp ? "" : " [library]"
        lines.push(`  at ${fn} (${file}:${line}${col ? `:${col}` : ""})${inApp}`)
      }
    }
  }

  return lines.join("\n")
}

/**
 * Extract breadcrumbs from a Sentry event.
 */
function extractBreadcrumbs(event: Record<string, unknown>): string {
  const entries = event.entries as Array<{ type: string; data: Record<string, unknown> }> | undefined
  if (!entries) return ""

  const breadcrumbEntry = entries.find((e) => e.type === "breadcrumbs")
  if (!breadcrumbEntry) return ""

  const values = (breadcrumbEntry.data.values as Array<Record<string, unknown>>) ?? []
  // Show last 10 breadcrumbs
  const recent = values.slice(-10)
  return recent
    .map((b) => {
      const ts = (b.timestamp as string) ?? ""
      const category = (b.category as string) ?? ""
      const message = (b.message as string) ?? ""
      const level = (b.level as string) ?? "info"
      return `[${ts}] ${level} ${category}: ${message}`
    })
    .join("\n")
}

/**
 * Format a Sentry issue as a prompt for the agent.
 */
function formatSentryPrompt(opts: {
  issue: Record<string, unknown>
  latestEvent: Record<string, unknown> | null
  repo: string
  issueUrl: string
}): string {
  const { issue, latestEvent } = opts
  const title = (issue.title as string) ?? "Unknown error"
  const culprit = (issue.culprit as string) ?? ""
  const platform = (issue.platform as string) ?? ""
  const level = (issue.level as string) ?? "error"
  const count = (issue.count as string) ?? "?"
  const userCount = (issue.userCount as number) ?? 0
  const firstSeen = (issue.firstSeen as string) ?? ""

  const stackTrace = latestEvent ? extractStackTrace(latestEvent) : ""
  const breadcrumbs = latestEvent ? extractBreadcrumbs(latestEvent) : ""
  const tags = latestEvent
    ? ((latestEvent.tags as Array<{ key: string; value: string }>) ?? []).map((t) => `${t.key}: ${t.value}`).join("\n")
    : ""

  const sections = [
    `# Sentry Issue: ${title}`,
    "",
    `**Repository:** ${opts.repo}`,
    `**Sentry URL:** ${opts.issueUrl}`,
    `**Platform:** ${platform}`,
    `**Level:** ${level}`,
    `**Culprit:** ${culprit}`,
    `**Occurrences:** ${count} (${userCount} users affected)`,
    `**First seen:** ${firstSeen}`,
    "",
    "## Task",
    "",
    "Investigate this error, find the root cause in the codebase, and create a fix PR.",
    "Use the stack trace below to locate the relevant code.",
  ]

  if (stackTrace) {
    sections.push("", "## Stack Trace", "", "```", stackTrace, "```")
  }

  if (breadcrumbs) {
    sections.push("", "## Breadcrumbs (last 10 events before the error)", "", "```", breadcrumbs, "```")
  }

  if (tags) {
    sections.push("", "## Tags", "", "```", tags, "```")
  }

  return sections.join("\n")
}

const router = new Hono<BaseEnv>().post("/", async (c) => {
  const logger = c.get("logger").child({ ns: "webhook.sentry" })
  const clientSecret = c.env.SENTRY_INTEGRATION_CLIENT_SECRET
  const token = c.env.SENTRY_INTEGRATION_TOKEN

  if (!clientSecret || !token) {
    return c.json({ error: "Sentry integration not configured" }, 503)
  }

  const rawBody = await c.req.text()

  // Verify HMAC-SHA256 signature
  const signature = c.req.header("sentry-hook-signature")
  if (!signature) {
    return c.json({ error: "Missing signature header" }, 401)
  }
  const isValid = await verifySentrySignature(rawBody, signature, clientSecret)
  if (!isValid) {
    return c.json({ error: "Invalid signature" }, 401)
  }

  let payload: Record<string, unknown> = {}
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>
  } catch {
    return c.json({ error: "Invalid JSON payload" }, 400)
  }

  const action = payload.action as string | undefined
  const resource = c.req.header("sentry-hook-resource") ?? "unknown"

  logger.info({ action, resource }, "sentry webhook received")

  // Only handle issue.assigned events
  if (resource !== "issue" || action !== "assigned") {
    return c.json({ ok: true, skipped: true, reason: `unhandled: ${resource}.${action}` })
  }

  const data = payload.data as Record<string, unknown> | undefined
  const issue = data?.issue as Record<string, unknown> | undefined
  if (!issue) {
    return c.json({ ok: true, skipped: true, reason: "no issue data" })
  }

  // Check if assigned to the trigger team
  const assignedTo = issue.assignedTo as { type?: string; name?: string; slug?: string } | null
  if (!assignedTo) {
    return c.json({ ok: true, skipped: true, reason: "no assignee" })
  }

  const isTeamAssignment = assignedTo.type === "team" && assignedTo.slug === TRIGGER_TEAM
  if (!isTeamAssignment) {
    logger.info(
      { assignee_type: assignedTo.type, assignee: assignedTo.slug ?? assignedTo.name },
      "skipping: not assigned to trigger team",
    )
    return c.json({ ok: true, skipped: true, reason: `assigned to ${assignedTo.slug ?? assignedTo.name}` })
  }

  const issueId = issue.id as string
  const issueUrl = (issue.web_url as string) ?? (issue.permalink as string) ?? ""
  const projectSlug = (issue.project as { slug?: string })?.slug ?? ""

  logger.info({ issue_id: issueId, project: projectSlug }, "sentry issue assigned to trigger team, dispatching")

  // Dispatch in waitUntil so we return 200 quickly
  const envBindings = c.env
  const db = c.get("db")
  const containerKey = `sentry/${projectSlug}#${issueId}`

  // Save initial session immediately so the container appears in the UI
  try {
    await saveInitialSession(db, containerKey)
  } catch {
    /* best effort — may conflict with existing row */
  }

  c.executionCtx.waitUntil(
    (async () => {
      try {
        logger.info({ issue_id: issueId, container_key: containerKey }, "sentry.dispatch.start")

        // Fetch full issue context from Sentry API
        const context = await fetchSentryIssueContext(issueId, token)
        logger.info({ issue_id: issueId }, "sentry.dispatch.context_fetched")

        // Determine the GitHub repo from the Sentry project
        // TODO: Use Sentry code mappings API to resolve project → repo automatically
        const repo = projectSlug ? `getsentry/${projectSlug}` : ""

        const { toAgentInstanceId } = await import("@/lib/containers/ids")
        const { createGitHubApp } = await import("@/lib/github/app")
        const { resolveFlueInternalToken } = await import("@/middlewares/flue-auth")
        const sandboxId = toAgentInstanceId(containerKey)
        const sandbox = getSandbox(envBindings.Sandbox, sandboxId, {
          normalizeId: true,
          sleepAfter: "2h",
        })

        // Mint a GitHub App installation token for the guessed repo so git/gh work.
        let installationToken = ""
        let botLogin = "jared-outpost[bot]"
        try {
          const app = createGitHubApp({
            appId: envBindings.GITHUB_APP_ID,
            privateKey: envBindings.GITHUB_APP_PRIVATE_KEY,
            webhookSecret: envBindings.GITHUB_APP_WEBHOOK_SECRET,
          })
          botLogin = await app.getBotLogin()
          if (repo.includes("/")) {
            const [owner, name] = repo.split("/")
            installationToken = (await app.getRepoInstallationToken(owner, name)) ?? ""
          }
        } catch (err) {
          logger.warn({ error: formatError(err), repo }, "sentry: failed to mint GitHub installation token")
        }

        logger.info(
          { issue_id: issueId, container_key: containerKey, sandbox_id: sandboxId },
          "sentry.dispatch.sandbox_ready.start",
        )
        const flueNative = envBindings.FLUE_NATIVE === "1" || envBindings.FLUE_NATIVE === "true"
        await ensureSandboxReady(sandbox, {
          repo: repo || null,
          botLogin,
          installationToken,
          openrouterApiKey: envBindings.OPENROUTER_API_KEY,
          anthropicApiKey: envBindings.ANTHROPIC_API_KEY,
          openaiApiKey: envBindings.OPENAI_API_KEY,
          sentryDsn: envBindings.SENTRY_DSN,
          entityKey: containerKey,
          appUrl: envBindings.APP_URL,
          thinSandbox: flueNative,
          loreGatewayUrl: envBindings.LORE_GATEWAY_URL,
          flueInternalToken: resolveFlueInternalToken(envBindings) ?? undefined,
        })
        logger.info(
          { issue_id: issueId, container_key: containerKey, sandbox_id: sandboxId },
          "sentry.dispatch.sandbox_ready.done",
        )

        const prompt = formatSentryPrompt({
          issue: context.issue,
          latestEvent: context.latestEvent,
          repo,
          issueUrl,
        })

        logger.info({ issue_id: issueId, container_key: containerKey }, "sentry.dispatch.prompt.start")
        const eventId = crypto.randomUUID()
        // Admit the prompt without blocking waitUntil on agent startup.
        if (flueNative) {
          const { dispatchToFlueAgent } = await import("@/lib/containers/flue-dispatch")
          await dispatchToFlueAgent(envBindings, { entityKey: containerKey, prompt, logger })
        } else {
          await dispatchPrompt(sandbox, containerKey, prompt, eventId)
        }
        logger.info({ issue_id: issueId, container_key: containerKey }, "sentry issue dispatched")
      } catch (err) {
        logger.error(
          { issue_id: issueId, container_key: containerKey, reason: formatError(err) },
          "sentry dispatch failed",
        )
        Sentry.captureException(err)
      }
    })(),
  )

  return c.json({ ok: true, issue_id: issueId, dispatched: true })
})

export default router
