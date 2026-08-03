/**
 * Cloudflare Sandbox Durable Object for Outpost.
 *
 * JaredSandbox wraps @cloudflare/sandbox with outbound Workers so the
 * GitHub token is injected at the egress proxy and never exposed to the model.
 */

import { Sandbox as CloudflareSandbox } from "@cloudflare/sandbox"

type OutboundEnv = {
  GITHUB_TOKEN?: string
  GH_TOKEN?: string
}

/**
 * Sandbox with zero-trust GitHub egress: Authorization is injected by the
 * outbound Worker proxy so the LLM/shell never sees the raw token.
 */
export class JaredSandbox extends CloudflareSandbox {
  static outboundByHost = {
    "api.github.com": (request: Request, env: OutboundEnv) => {
      const headers = new Headers(request.headers)
      const token = env.GITHUB_TOKEN || env.GH_TOKEN
      if (token) {
        headers.set("Authorization", `Bearer ${token}`)
      }
      return fetch(request, { headers })
    },
    "github.com": (request: Request, env: OutboundEnv) => {
      const headers = new Headers(request.headers)
      const token = env.GITHUB_TOKEN || env.GH_TOKEN
      if (token && !headers.has("Authorization")) {
        headers.set("Authorization", `Bearer ${token}`)
      }
      return fetch(request, { headers })
    },
  }
}

/** Wrangler class_name "Sandbox" binding. */
export { JaredSandbox as Sandbox }
