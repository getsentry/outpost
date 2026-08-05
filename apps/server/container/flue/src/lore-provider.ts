/**
 * Phase 1: when in-container Lore is healthy, OPENAI/ANTHROPIC base URLs are
 * set by the Worker. OpenRouter-prefixed models still need an explicit provider
 * override — register it when LORE_GATEWAY_URL points at a reachable gateway.
 */

import { createProvider } from "@earendil-works/pi-ai"
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy"
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter"
import { setProvider } from "@flue/runtime"

export function registerLoreOpenRouterProvider(): void {
  const gateway = process.env.LORE_GATEWAY_URL?.replace(/\/$/, "")
  if (!gateway) return
  // Only override when the Worker health probe enabled provider base URLs,
  // or when LORE is explicitly external. Loopback without OPENAI_BASE_URL means
  // Lore was unhealthy — skip the override so OpenRouter stays direct.
  if (/127\.0\.0\.1|localhost/.test(gateway) && !process.env.OPENAI_BASE_URL) return

  const base = openrouterProvider()
  setProvider(
    createProvider({
      id: "openrouter",
      auth: {
        apiKey: {
          name: "OpenRouter via Lore",
          resolve: async () => ({ auth: { apiKey: process.env.OPENROUTER_API_KEY } }),
        },
      },
      models: base.getModels().map((model) => ({
        ...model,
        baseUrl: `${gateway}/v1`,
      })),
      api: openAICompletionsApi(),
    }),
  )
}
