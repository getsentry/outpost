/**
 * Shared auth helpers for Worker-internal Flue/session traffic.
 *
 * Public agent HTTP mounts and the session ingest endpoint must not be open.
 * Callers with a logged-in user OR a matching internal token are admitted.
 *
 * The token written into sandboxes / compared on the wire is NEVER the raw
 * Better Auth session-signing secret. Prefer an explicit FLUE_INTERNAL_TOKEN;
 * otherwise derive a purpose-bound HMAC so deploys without a new secret still
 * work without shipping BETTER_AUTH_SECRET into agent containers.
 */

import { createMiddleware } from "hono/factory"
import type { AuthEnv } from "@/types"

export const FLUE_INTERNAL_HEADER = "x-flue-internal-token"

/** Purpose string for deriving a sandbox-safe token from BETTER_AUTH_SECRET. */
const FLUE_INTERNAL_DERIVE_PURPOSE = "outpost-flue-internal-v1"

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ])
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

/**
 * Resolve the shared internal token used for Worker↔container session ingest
 * and Worker-internal Flue history pulls.
 *
 * Never returns the raw BETTER_AUTH_SECRET — that would let a compromised
 * sandbox forge dashboard sessions.
 */
export async function resolveFlueInternalToken(env: {
  FLUE_INTERNAL_TOKEN?: string
  BETTER_AUTH_SECRET?: string
}): Promise<string | null> {
  if (env.FLUE_INTERNAL_TOKEN && env.FLUE_INTERNAL_TOKEN.length > 0) {
    return env.FLUE_INTERNAL_TOKEN
  }
  if (env.BETTER_AUTH_SECRET && env.BETTER_AUTH_SECRET.length > 0) {
    return hmacSha256Hex(env.BETTER_AUTH_SECRET, FLUE_INTERNAL_DERIVE_PURPOSE)
  }
  return null
}

/** Constant-time equality for equal-length secrets (portable across Node + Workers). */
export function timingSafeEqualString(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const aBytes = enc.encode(a)
  const bBytes = enc.encode(b)
  if (aBytes.byteLength !== bBytes.byteLength) return false
  let diff = 0
  for (let i = 0; i < aBytes.byteLength; i++) {
    diff |= aBytes[i]! ^ bBytes[i]!
  }
  return diff === 0
}

export async function requestHasFlueInternalToken(
  headerValue: string | undefined,
  env: { FLUE_INTERNAL_TOKEN?: string; BETTER_AUTH_SECRET?: string },
): Promise<boolean> {
  const expected = await resolveFlueInternalToken(env)
  if (!expected || !headerValue) return false
  return timingSafeEqualString(headerValue, expected)
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
  if (await requestHasFlueInternalToken(header, c.env)) {
    await next()
    return
  }

  return c.json({ error: "Unauthorized" }, 401)
})
