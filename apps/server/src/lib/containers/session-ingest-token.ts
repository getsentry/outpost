/**
 * Per-entity session-ingest tokens.
 *
 * The shared FLUE internal token must never be written into agent sandboxes
 * (they execute untrusted repo code). Instead we mint a short-lived HMAC that
 * is valid only for one entityKey — a leak from one sandbox cannot forge
 * session data for other entities or unlock /agents/jared.
 */

import { timingSafeEqualString } from "@/middlewares/flue-auth"

/** Match the Phase 1 reporter / keepalive budget (~2h). */
export const SESSION_INGEST_TOKEN_TTL_MS = 2 * 60 * 60 * 1000

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ])
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

function encodeEntityKey(entityKey: string): string {
  const bytes = new TextEncoder().encode(entityKey)
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

function decodeEntityKey(encoded: string): string | null {
  try {
    const padded = encoded.replace(/-/g, "+").replace(/_/g, "/")
    const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4))
    const bin = atob(padded + pad)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}

/**
 * Mint `v1.<entityKeyB64url>.<expUnixSec>.<hmacHex>` scoped to one entity.
 */
export async function mintSessionIngestToken(secret: string, entityKey: string, now = Date.now()): Promise<string> {
  const exp = Math.floor((now + SESSION_INGEST_TOKEN_TTL_MS) / 1000)
  const mac = await hmacSha256Hex(secret, `${entityKey}:${exp}`)
  return `v1.${encodeEntityKey(entityKey)}.${exp}.${mac}`
}

/**
 * Verify an ingest token is unexpired, matches entityKey, and has a valid MAC.
 */
export async function verifySessionIngestToken(
  secret: string,
  token: string,
  entityKey: string,
  now = Date.now(),
): Promise<boolean> {
  const parts = token.split(".")
  if (parts.length !== 4 || parts[0] !== "v1") return false
  const [, ekEnc, expStr, mac] = parts
  if (!ekEnc || !expStr || !mac) return false

  const exp = Number(expStr)
  if (!Number.isFinite(exp) || exp * 1000 < now) return false

  const decoded = decodeEntityKey(ekEnc)
  if (!decoded || !timingSafeEqualString(decoded, entityKey)) return false

  const expectedMac = await hmacSha256Hex(secret, `${entityKey}:${exp}`)
  return timingSafeEqualString(mac, expectedMac)
}
