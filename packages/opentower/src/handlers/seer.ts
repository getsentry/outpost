// Hono handler for POST /webhooks/seer. Accepts Sentry's
// CodingAgentLaunchRequest, verifies HMAC, dispatches to an OpenCode
// session, and returns a CodingAgentState response synchronously.

import type { Context } from "hono"
import * as Sentry from "@sentry/bun"
import type { AppEnv } from "../handler"
import { verifySha256Signature } from "../hmac"
import { readBodyBytes } from "../http"
import { evaluateAndDispatch } from "../matchers"

type SeerRepoDefinition = {
  provider: string
  owner: string
  name: string
  external_id: string
  branch_name?: string | null
}

type CodingAgentLaunchRequest = {
  prompt: string
  repository: SeerRepoDefinition
  branch_name: string
  auto_create_pr: boolean
  webhook_url?: string
  webhook_secret?: string
}

export async function seerWebhookHandler(c: Context<AppEnv>) {
  const seerSecret = c.get("seerSecret")
  const triggers = c.get("seerTriggers")
  const pipeline = c.get("pipeline")

  if (!seerSecret) {
    return c.json({ error: "no Seer HMAC secret configured on server" }, 503)
  }

  const body = await readBodyBytes(c.req.raw)
  if (!body.ok) return body.response

  const rawBody = new TextDecoder("utf-8").decode(body.bytes)
  const signature = c.req.header("x-seer-signature-256") ?? null
  if (!verifySha256Signature(rawBody, signature, seerSecret)) {
    return c.json({ error: "invalid signature" }, 401)
  }

  let request: CodingAgentLaunchRequest
  try {
    request = parseLaunchRequest(rawBody)
  } catch (err) {
    return c.json({ error: "invalid request body", detail: String(err) }, 400)
  }

  const deliveryId = crypto.randomUUID()
  const agentId = crypto.randomUUID()
  const repo = `${request.repository.owner}/${request.repository.name}`

  Sentry.logger.info("webhook.received", {
    source: "seer",
    event: "seer.coding_agent_launch",
    delivery_id: deliveryId,
    repo,
    branch: request.branch_name,
  })

  const seerPayload = {
    prompt: request.prompt,
    repository: request.repository,
    branch_name: request.branch_name,
    auto_create_pr: request.auto_create_pr,
    webhook_url: request.webhook_url ?? null,
    webhook_secret: request.webhook_secret ?? null,
    agent_id: agentId,
    repo,
  }

  const { dispatched, skipped } = evaluateAndDispatch({
    triggers,
    event: "seer.coding_agent_launch",
    action: null,
    payload: seerPayload,
    sender: null,
    botLogin: null,
    deliveryId,
    templateContext: {
      event: "seer.coding_agent_launch",
      action: null,
      delivery_id: deliveryId,
      payload: seerPayload,
    },
    pipeline,
  })

  return c.json({
    id: agentId,
    status: dispatched.length > 0 ? "running" : "failed",
    provider: "outpost_agent",
    name: `Outpost Agent: ${repo}`,
    started_at: new Date().toISOString(),
    results: [],
    dispatched,
    ...(skipped.length > 0 ? { skipped } : {}),
  })
}

function parseLaunchRequest(raw: string): CodingAgentLaunchRequest {
  const obj = JSON.parse(raw) as unknown
  if (typeof obj !== "object" || obj === null) {
    throw new Error("body is not an object")
  }
  const o = obj as Record<string, unknown>
  if (typeof o.prompt !== "string") throw new Error("missing 'prompt'")
  if (typeof o.repository !== "object" || o.repository === null) {
    throw new Error("missing 'repository'")
  }
  const repo = o.repository as Record<string, unknown>
  if (typeof repo.owner !== "string") throw new Error("missing 'repository.owner'")
  if (typeof repo.name !== "string") throw new Error("missing 'repository.name'")
  if (typeof repo.provider !== "string") throw new Error("missing 'repository.provider'")
  if (typeof repo.external_id !== "string") throw new Error("missing 'repository.external_id'")
  if (typeof o.branch_name !== "string") throw new Error("missing 'branch_name'")

  return {
    prompt: o.prompt,
    repository: {
      provider: repo.provider,
      owner: repo.owner,
      name: repo.name,
      external_id: repo.external_id,
      branch_name: typeof repo.branch_name === "string" ? repo.branch_name : null,
    },
    branch_name: o.branch_name,
    auto_create_pr: o.auto_create_pr === true,
    webhook_url: typeof o.webhook_url === "string" ? o.webhook_url : undefined,
    webhook_secret: typeof o.webhook_secret === "string" ? o.webhook_secret : undefined,
  }
}
