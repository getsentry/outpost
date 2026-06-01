// HMAC verification for GitHub webhooks using Web Crypto API.

export async function verifyGithubSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false

  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )

  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody))
  const hexDigest = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
  const expected = `sha256=${hexDigest}`

  // Constant-time comparison
  if (expected.length !== signatureHeader.length) return false
  let result = 0
  for (let i = 0; i < expected.length; i++) {
    result |= expected.charCodeAt(i) ^ signatureHeader.charCodeAt(i)
  }
  return result === 0
}

export async function safeTokenCompare(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode("outpost-token-compare"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )

  const ha = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(a)))
  const hb = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(b)))

  if (ha.length !== hb.length) return false
  let result = 0
  for (let i = 0; i < ha.length; i++) {
    result |= ha[i] ^ hb[i]
  }
  return result === 0
}
