/**
 * Cloudflare Sandbox Durable Object for Outpost.
 *
 * JaredSandbox wraps @cloudflare/sandbox with outbound Workers so the
 * GitHub token is injected at the egress proxy and never exposed to the model.
 */

import { Sandbox as CloudflareSandbox } from "@cloudflare/sandbox"
import { RunLeaseManager } from "./run-lease"

type OutboundEnv = {
  GITHUB_TOKEN?: string
  GH_TOKEN?: string
}

/**
 * Sandbox with optional GitHub egress injection via outbound Workers.
 *
 * NOTE: outbound handlers only inject a token when `GITHUB_TOKEN` / `GH_TOKEN`
 * is present on the Worker env. Today Outpost mints installation tokens per
 * event and applies them inside the container via `applyGitHubAuth` — so these
 * handlers are a no-op unless that Worker-level secret is also configured.
 * Keep them for the zero-trust path when we move token injection out of the sandbox.
 */
export class JaredSandbox extends CloudflareSandbox {
  private runLeases = new RunLeaseManager({
    storage: this.ctx.storage,
    now: Date.now,
    setKeepAlive: (value) => this.setKeepAlive(value),
    schedule: (seconds, payload) => this.schedule(seconds, "expireRunLease", payload),
  })

  acquireRunLease(id: string) {
    return this.runLeases.acquire(id)
  }
  releaseRunLease(id: string) {
    return this.runLeases.release(id)
  }
  expireRunLease(payload: { id: string; expiresAt: number }) {
    return this.runLeases.expire(payload)
  }

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
