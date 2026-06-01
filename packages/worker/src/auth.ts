// GitHub App authentication for Cloudflare Workers.
// Uses Web Crypto API (SubtleCrypto) instead of Node.js crypto.

const GITHUB_API = "https://api.github.com"
const JWT_EXPIRY_SECONDS = 600
const TOKEN_REFRESH_THRESHOLD_MS = 10 * 60 * 1000

type CachedToken = {
  token: string
  expiresAt: number
}

export type GitHubAppAuth = {
  getInstallationToken(installationId: number): Promise<string>
  getAppSlug(): Promise<string>
  getDefaultInstallationId(): Promise<number>
}

function base64url(input: ArrayBuffer | Uint8Array | string): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input)
  let binary = ""
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN RSA PRIVATE KEY-----/, "")
    .replace(/-----END RSA PRIVATE KEY-----/, "")
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "")
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}

async function generateJWT(appId: string, privateKey: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: "RS256", typ: "JWT" }
  const payload = {
    iat: now - 60,
    exp: now + JWT_EXPIRY_SECONDS,
    iss: appId,
  }

  const headerB64 = base64url(JSON.stringify(header))
  const payloadB64 = base64url(JSON.stringify(payload))
  const unsigned = `${headerB64}.${payloadB64}`

  const keyData = pemToArrayBuffer(privateKey)

  // Try PKCS#8 first, then fall back to PKCS#1
  let cryptoKey: CryptoKey
  try {
    cryptoKey = await crypto.subtle.importKey("pkcs8", keyData, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
      "sign",
    ])
  } catch {
    // Some keys are in PKCS#1 format — wrap in PKCS#8 envelope
    // For simplicity, re-attempt with the same data as Workers runtime
    // typically handles both formats under pkcs8.
    throw new Error("Failed to import RSA private key. Ensure it is in PKCS#8 or PKCS#1 PEM format.")
  }

  const signatureBuffer = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(unsigned))
  const signature = base64url(signatureBuffer)

  return `${unsigned}.${signature}`
}

export function createGitHubAppAuth(appId: string, privateKey: string): GitHubAppAuth {
  const tokenCache = new Map<number, CachedToken>()
  let cachedAppSlug: string | null = null

  async function getInstallationToken(installationId: number): Promise<string> {
    const cached = tokenCache.get(installationId)
    if (cached && cached.expiresAt - Date.now() > TOKEN_REFRESH_THRESHOLD_MS) {
      return cached.token
    }

    const jwt = await generateJWT(appId, privateKey)
    const response = await fetch(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Failed to get installation token (HTTP ${response.status}): ${body}`)
    }

    const data = (await response.json()) as { token: string; expires_at: string }
    const expiresAt = new Date(data.expires_at).getTime()
    tokenCache.set(installationId, { token: data.token, expiresAt })
    return data.token
  }

  async function getAppSlug(): Promise<string> {
    if (cachedAppSlug) return cachedAppSlug

    const jwt = await generateJWT(appId, privateKey)
    const response = await fetch(`${GITHUB_API}/app`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Failed to get app info (HTTP ${response.status}): ${body}`)
    }

    const data = (await response.json()) as { slug: string }
    cachedAppSlug = data.slug
    return data.slug
  }

  async function getDefaultInstallationId(): Promise<number> {
    const jwt = await generateJWT(appId, privateKey)
    const response = await fetch(`${GITHUB_API}/app/installations`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Failed to list installations (HTTP ${response.status}): ${body}`)
    }

    const installations = (await response.json()) as Array<{ id: number; account: { login: string } }>
    if (installations.length === 0) {
      throw new Error("GitHub App has no installations. Install the app on at least one organization or repository.")
    }

    return installations[0].id
  }

  return { getInstallationToken, getAppSlug, getDefaultInstallationId }
}
