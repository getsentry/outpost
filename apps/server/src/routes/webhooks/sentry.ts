// Sentry webhook handler.
//
// Receives webhook events from a Sentry internal integration when issues
// are assigned to the Jared agent. Extracts error context (stack trace,
// breadcrumbs, tags) and dispatches a fix prompt to the OpenCode sandbox.
//
// Flow:
//   1. Issue assigned to "jared" in Sentry → webhook fires
//   2. Worker fetches full issue details (stack trace, events, tags)
//   3. Formats a prompt with the error context
//   4. Dispatches to a container (same as GitHub flow)
//
// TODO: Implement once the Sentry internal integration is created.
//       See MESSAGE.md for the integration request details.

import { Hono } from "hono"
import type { BaseEnv } from "@/types"

const router = new Hono<BaseEnv>().post("/", async (c) => {
  const logger = c.get("logger").child({ ns: "webhook.sentry" })

  // Verify the webhook signature using the client secret
  // const clientSecret = c.env.SENTRY_INTEGRATION_CLIENT_SECRET
  // TODO: implement HMAC verification

  const rawBody = await c.req.text()
  let payload: Record<string, unknown> = {}
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>
  } catch {
    return c.json({ error: "Invalid JSON payload" }, 400)
  }

  const action = payload.action as string | undefined
  const resource = payload.resource as string | undefined

  logger.info({ action, resource }, "sentry webhook received")

  // TODO: Handle issue assignment events
  // Expected flow:
  // 1. Check if action === "assigned" and assignee is "jared"
  // 2. Extract issue ID, project slug, organization slug
  // 3. Fetch full issue details from Sentry API:
  //    - GET /api/0/issues/{issue_id}/
  //    - GET /api/0/issues/{issue_id}/events/latest/
  //    - Extract: title, culprit, stack trace, breadcrumbs, tags, platform
  // 4. Determine the repo from the Sentry project's code mappings
  // 5. Format a prompt with the error context
  // 6. Dispatch to container (reuse ensureSandboxReady + dispatchPrompt)

  return c.json({ ok: true, status: "not_implemented" })
})

export default router
