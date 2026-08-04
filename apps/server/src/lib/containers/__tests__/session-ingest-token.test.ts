import { describe, expect, it } from "vitest"
import { mintSessionIngestToken, SESSION_INGEST_TOKEN_TTL_MS, verifySessionIngestToken } from "../session-ingest-token"

describe("session ingest tokens", () => {
  const secret = "test-secret"

  it("mints a token that verifies for the same entity", async () => {
    const token = await mintSessionIngestToken(secret, "acme/app#42")
    expect(await verifySessionIngestToken(secret, token, "acme/app#42")).toBe(true)
  })

  it("rejects a token used for a different entityKey", async () => {
    const token = await mintSessionIngestToken(secret, "acme/app#42")
    expect(await verifySessionIngestToken(secret, token, "other/repo#1")).toBe(false)
  })

  it("rejects an expired token", async () => {
    const now = Date.UTC(2026, 7, 4, 12, 0, 0)
    const token = await mintSessionIngestToken(secret, "acme/app#42", now)
    const later = now + SESSION_INGEST_TOKEN_TTL_MS + 1000
    expect(await verifySessionIngestToken(secret, token, "acme/app#42", later)).toBe(false)
  })

  it("rejects a tampered mac", async () => {
    const token = await mintSessionIngestToken(secret, "acme/app#42")
    const tampered = `${token.slice(0, -4)}dead`
    expect(await verifySessionIngestToken(secret, tampered, "acme/app#42")).toBe(false)
  })
})
