/**
 * Shared auth helpers for Worker-internal Flue/session traffic.
 *
 * Public agent HTTP mounts and the unauthenticated session ingest endpoint
 * must not be open. Callers with a logged-in user OR a matching internal
 * token (session cookie-less Worker/container traffic) are admitted.
 */

import { createMiddleware } from "hono/factory"
import type { AuthEnv } from "@/types"

export const FLUE_INTERNAL_HEADER = "x-flue-internal-token"

/** Prefer an explicit secret; fall back to BETTER_AUTH_SECRET so deploys work without a new var. */
export function resolveFlueInternalToken(env: {
  FLUE_INTERNAL_TOKEN?: string
  BETTER_AUTH_SECRET?: string
}): string | null {
  const token = env.FLUE_INTERNAL_TOKEN || env.BETTER_AUTH_SECRET
  return token && token.length > 0 ? token : null
}

export function requestHasFlueInternalToken(
  headerValue: string | undefined,
  env: { FLUE_INTERNAL_TOKEN?: string; BETTER_AUTH_SECRET?: string },
): boolean {
  const expected = resolveFlueInternalToken(env)
  if (!expected || !headerValue) return false
  return headerValue === expected
}

/**
 * Allow authenticated dashboard users OR Worker/container callers that present
 * the shared internal token. Reject everyone else.
 */
export const requireUserOrInternalToken = createMiddleware<AuthEnv>(async (c, next) => {
  if (c.get("user")) {
    await next()
    return
  }

  const header = c.req.header(FLUE_INTERNAL_HEADER) ?? c.req.header("authorization")?.replace(/^Bearer\s+/i, "")
  if (requestHasFlueInternalToken(header, c.env)) {
    await next()
    return
  }

  return c.json({ error: "Unauthorized" }, 401)
})
