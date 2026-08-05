// Phase 2: ensure a DO-initiated turn runs against a prepped thin sandbox.
//
// On a webhook event the Worker runs ensureSandboxReady (clone + GH auth) before
// admitting the prompt. But scheduled follow-ups (auto-merge / fix-ci via the DO
// `scheduleFollowUp`) and post-teardown resumes reach the agent Durable Object
// directly — the container may have been torn down (~10m idle) and respun empty,
// so `git`/`gh` would fail. This closes that gap by re-cloning + re-authing at the
// start of such turns. Idempotent and best-effort (never throws into the turn).

import { getSandbox } from "@cloudflare/sandbox"
import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"
import * as dbSchema from "@/db/schema"
import { createGitHubApp } from "@/lib/github/app"
import { ensureSandboxReady } from "./dispatch"
import { SANDBOX_OPTS } from "./sandbox-opts"

export type DoPrepEnv = {
  Sandbox: DurableObjectNamespace
  DB: D1Database
  GITHUB_APP_ID: string
  GITHUB_APP_PRIVATE_KEY: string
  GITHUB_APP_WEBHOOK_SECRET: string
  OPENROUTER_API_KEY?: string
  ANTHROPIC_API_KEY?: string
  OPENAI_API_KEY?: string
  SENTRY_DSN?: string
  APP_URL?: string
  LORE_GATEWAY_URL?: string
}

/**
 * Derive `owner/repo` from an entity key like `getsentry/cli#1365` (or the
 * PR-less `getsentry/cli`). Returns null when the shape is not `owner/repo[...]`.
 */
export function parseOwnerRepo(entityKey: string): { owner: string; repo: string; slug: string } | null {
  const slug = entityKey.split("#")[0]?.trim()
  if (!slug) return null
  const [owner, repo, ...rest] = slug.split("/")
  if (!owner || !repo || rest.length > 0) return null
  return { owner, repo, slug: `${owner}/${repo}` }
}

/**
 * Ensure the thin sandbox for `instanceId` has a cloned repo + fresh GH auth.
 *
 * @param force When true (DO-initiated / scheduled turns that bypass the Worker),
 *   always (re)prep — refreshing the ~1h GitHub token even if the clone survived.
 *   When false (webhook turns the Worker already prepped), only prep if the clone
 *   is missing, as cheap defense against an unexpected teardown.
 */
export async function ensureDoSandboxPrepped(env: DoPrepEnv, instanceId: string, force: boolean): Promise<void> {
  const sandbox = getSandbox(env.Sandbox, instanceId, SANDBOX_OPTS)

  if (!force) {
    const hasRepo = await sandbox
      .exec("test -d /workspace/repo/.git", { cwd: "/workspace" })
      .then((r) => r.success)
      .catch(() => false)
    if (hasRepo) return
  }

  const db = drizzle(env.DB, { schema: dbSchema })
  const rows = await db
    .select({ entityKey: dbSchema.agentSessions.entityKey })
    .from(dbSchema.agentSessions)
    .where(eq(dbSchema.agentSessions.sessionId, instanceId))
    .limit(1)
  const entityKey = rows[0]?.entityKey
  if (!entityKey) {
    console.warn("do-prep: no agent_sessions row", { instanceId })
    return
  }

  const parsed = parseOwnerRepo(entityKey)
  if (!parsed) {
    console.warn("do-prep: cannot derive repo from entity key", { entityKey })
    return
  }

  const app = createGitHubApp({
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET,
  })
  const [installationToken, botLogin] = await Promise.all([
    app.getRepoInstallationToken(parsed.owner, parsed.repo),
    app.getBotLogin().catch(() => ""),
  ])
  if (!installationToken) {
    console.warn("do-prep: no installation token", { repo: parsed.slug })
    return
  }

  await ensureSandboxReady(sandbox, {
    repo: parsed.slug,
    botLogin,
    installationToken,
    entityKey,
    openrouterApiKey: env.OPENROUTER_API_KEY,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    openaiApiKey: env.OPENAI_API_KEY,
    sentryDsn: env.SENTRY_DSN,
    appUrl: env.APP_URL,
    thinSandbox: true,
    loreGatewayUrl: env.LORE_GATEWAY_URL,
  })
}
