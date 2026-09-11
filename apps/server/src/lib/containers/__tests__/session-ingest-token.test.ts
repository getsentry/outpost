import { describe, expect, it } from "vitest"
import {
  mintSessionIngestToken,
  SESSION_INGEST_TOKEN_TTL_MS,
  SESSION_REPORTER_MAX_MS,
  verifySessionIngestToken,
} from "../session-ingest-token"

describe("session ingest tokens", () => {
  const secret = "test-secret"

  it("mints a token that verifies for the same entity", async () => {
    const token = await mintSessionIngestToken(secret, "acme/app#42", 1)
    expect(await verifySessionIngestToken(secret, token, "acme/app#42", 1)).toBe(true)
  })

  it("rejects a token used for a different entityKey", async () => {
    const token = await mintSessionIngestToken(secret, "acme/app#42", 1)
    expect(await verifySessionIngestToken(secret, token, "other/repo#1", 1)).toBe(false)
  })

  it("rejects an expired token", async () => {
    const now = Date.UTC(2026, 7, 4, 12, 0, 0)
    const token = await mintSessionIngestToken(secret, "acme/app#42", 1, now)
    const later = now + SESSION_INGEST_TOKEN_TTL_MS + 1000
    expect(await verifySessionIngestToken(secret, token, "acme/app#42", 1, later)).toBe(false)
  })

  it("still verifies at the end of the reporter budget", async () => {
    // Token is minted once at reporter start; must remain valid through MAX=7200s.
    const now = Date.UTC(2026, 7, 4, 12, 0, 0)
    const token = await mintSessionIngestToken(secret, "acme/app#42", 1, now)
    const atReporterExit = now + SESSION_REPORTER_MAX_MS
    expect(SESSION_INGEST_TOKEN_TTL_MS).toBeGreaterThan(SESSION_REPORTER_MAX_MS)
    expect(await verifySessionIngestToken(secret, token, "acme/app#42", 1, atReporterExit)).toBe(true)
  })

  it("rejects a tampered mac", async () => {
    const token = await mintSessionIngestToken(secret, "acme/app#42", 1)
    const tampered = `${token.slice(0, -4)}dead`
    expect(await verifySessionIngestToken(secret, tampered, "acme/app#42", 1)).toBe(false)
  })

  it("rejects a valid token after destroy and restart, including a forged generation", async () => {
    const token = await mintSessionIngestToken(secret, "acme/app#42", 1)
    expect(await verifySessionIngestToken(secret, token, "acme/app#42", null)).toBe(false)
    expect(await verifySessionIngestToken(secret, token, "acme/app#42", 2)).toBe(false)
    const parts = token.split(".")
    parts[3] = "2"
    expect(await verifySessionIngestToken(secret, parts.join("."), "acme/app#42", 2)).toBe(false)
  })

  it("allows legacy v1 tokens only before the first reset", async () => {
    const exp = Math.floor(Date.now() / 1000) + 600
    const { createHmac } = await import("node:crypto")
    const mac = createHmac("sha256", secret).update(`acme/app#42:${exp}`).digest("hex")
    const token = `v1.${btoa("acme/app#42")}.${exp}.${mac}`
    expect(await verifySessionIngestToken(secret, token, "acme/app#42", 0)).toBe(true)
    expect(await verifySessionIngestToken(secret, token, "acme/app#42", 1)).toBe(true)
    expect(await verifySessionIngestToken(secret, token, "acme/app#42", 2)).toBe(false)
  })
})
