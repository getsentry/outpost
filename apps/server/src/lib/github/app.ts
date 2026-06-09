// GitHub App authentication and Octokit client factory.
//
// Uses @octokit/auth-app for JWT generation and installation token
// management (with built-in caching). Provides helpers to create
// per-installation Octokit clients for API calls.

import { createAppAuth } from "@octokit/auth-app"
import { Octokit } from "@octokit/rest"

export type GitHubAppConfig = {
  appId: string
  privateKey: string
  webhookSecret: string
}

/**
 * Create a GitHub App auth strategy from Cloudflare Worker env bindings.
 * The returned auth function can generate JWTs and installation tokens.
 */
// Module-level cache for bot login — the slug never changes for a given app.
const botLoginCache = new Map<string, string>()

/**
 * Convert a PKCS#1 (RSA PRIVATE KEY) PEM to PKCS#8 (PRIVATE KEY) PEM.
 * GitHub generates PKCS#1 keys, but universal-github-app-jwt requires PKCS#8.
 * If the key is already PKCS#8, it is returned unchanged.
 */
function ensurePKCS8(pem: string): string {
  if (!pem.includes("BEGIN RSA PRIVATE KEY")) return pem

  // Strip PEM headers and decode base64 to get the raw PKCS#1 DER bytes
  const b64 = pem.replace(/-----(?:BEGIN|END) RSA PRIVATE KEY-----|\s/g, "")
  const pkcs1Der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))

  // Wrap PKCS#1 DER in a PKCS#8 ASN.1 envelope:
  //   SEQUENCE {
  //     INTEGER 0 (version)
  //     SEQUENCE { OID 1.2.840.113549.1.1.1 (rsaEncryption), NULL }
  //     OCTET STRING <pkcs1Der>
  //   }
  const rsaOid = new Uint8Array([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00])

  function derLength(length: number): Uint8Array {
    if (length < 0x80) return new Uint8Array([length])
    if (length < 0x100) return new Uint8Array([0x81, length])
    return new Uint8Array([0x82, (length >> 8) & 0xff, length & 0xff])
  }

  function derSequence(...parts: Uint8Array[]): Uint8Array {
    const body = new Uint8Array(parts.reduce((s, p) => s + p.length, 0))
    let offset = 0
    for (const p of parts) {
      body.set(p, offset)
      offset += p.length
    }
    const len = derLength(body.length)
    const seq = new Uint8Array(1 + len.length + body.length)
    seq[0] = 0x30
    seq.set(len, 1)
    seq.set(body, 1 + len.length)
    return seq
  }

  const version = new Uint8Array([0x02, 0x01, 0x00])
  const algorithmId = derSequence(rsaOid)
  const octetLen = derLength(pkcs1Der.length)
  const octetString = new Uint8Array(1 + octetLen.length + pkcs1Der.length)
  octetString[0] = 0x04
  octetString.set(octetLen, 1)
  octetString.set(pkcs1Der, 1 + octetLen.length)

  const pkcs8Der = derSequence(version, algorithmId, octetString)
  const pkcs8B64 = btoa(String.fromCharCode(...pkcs8Der))
  const lines = pkcs8B64.match(/.{1,64}/g) ?? []

  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----`
}

export function createGitHubApp(config: GitHubAppConfig) {
  // Normalize PEM key: env vars often store literal "\n" instead of newlines,
  // and GitHub generates PKCS#1 keys which need conversion to PKCS#8.
  const privateKey = ensurePKCS8(config.privateKey.replace(/\\n/g, "\n"))

  const auth = createAppAuth({
    appId: config.appId,
    privateKey,
  })

  return {
    auth,
    webhookSecret: config.webhookSecret,

    /**
     * Create an Octokit client authenticated as a specific installation.
     * The token is automatically cached and refreshed by @octokit/auth-app.
     */
    getInstallationOctokit(installationId: number): Octokit {
      return new Octokit({
        authStrategy: createAppAuth,
        auth: {
          appId: config.appId,
          privateKey,
          installationId,
        },
      })
    },

    /**
     * Resolve the GitHub App's bot login (e.g. "my-app[bot]").
     * Cached at the module level — the app slug never changes.
     */
    async getBotLogin(): Promise<string> {
      const cached = botLoginCache.get(config.appId)
      if (cached) return cached

      const appOctokit = new Octokit({
        authStrategy: createAppAuth,
        auth: {
          appId: config.appId,
          privateKey,
        },
      })
      const { data } = await appOctokit.apps.getAuthenticated()
      const login = `${data.slug}[bot]`
      botLoginCache.set(config.appId, login)
      return login
    },
  }
}

export type GitHubApp = ReturnType<typeof createGitHubApp>
