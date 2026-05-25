// Handler registry: creates and collects all enabled WebhookHandlers
// based on the current configuration.

import { type GitHubAppAuth, createGitHubAppAuth } from "../github-app-auth"
import type { WebhookHandler } from "../interfaces"
import type { GithubAppConfig, NormalizedTrigger } from "../types"
import { createGithubAppHandler } from "./github-app"

export type HandlerRegistryOptions = {
  triggers: NormalizedTrigger[]
  githubApp: GithubAppConfig
}

export type HandlerRegistryResult = {
  handlers: WebhookHandler[]
  auth: GitHubAppAuth
}

export function createHandlers(opts: HandlerRegistryOptions): HandlerRegistryResult {
  const triggers = opts.triggers.filter((t) => t.source === "github_app")
  const auth = createGitHubAppAuth(opts.githubApp.app_id, opts.githubApp.private_key)

  const handlers: WebhookHandler[] = []
  if (triggers.length > 0) {
    handlers.push(
      createGithubAppHandler({
        webhookSecret: opts.githubApp.webhook_secret,
        triggers,
        auth,
      }),
    )
  }

  return { handlers, auth }
}
