/**
 * When LORE_GATEWAY_URL is set, re-register the OpenRouter provider so every
 * `openrouter/...` model call goes through Lore instead of api.openrouter.ai.
 *
 * Safe no-op when the gateway URL is unset — built-in OpenRouter stays in place.
 */

import { env } from "cloudflare:workers"
import { createProvider } from "@earendil-works/pi-ai"
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy"
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter"
import { setProvider } from "@flue/runtime"

type LoreEnv = {
  LORE_GATEWAY_URL?: string
  OPENROUTER_API_KEY?: string
}

function loreGatewayBase(): string | null {
  const bindings = env as unknown as LoreEnv
  const fromEnv =
    bindings.LORE_GATEWAY_URL || (typeof process !== "undefined" ? process.env.LORE_GATEWAY_URL : undefined)
  return fromEnv ? fromEnv.replace(/\/$/, "") : null
}

function openRouterApiKey(): string | undefined {
  const bindings = env as unknown as LoreEnv
  return bindings.OPENROUTER_API_KEY || (typeof process !== "undefined" ? process.env.OPENROUTER_API_KEY : undefined)
}

/**
 * Override the built-in `openrouter` provider to point at Lore's OpenAI-compatible
 * `/v1` surface when a gateway URL is configured.
 */
export function registerLoreOpenRouterProvider(): void {
  const gateway = loreGatewayBase()
  if (!gateway) return

  const base = openrouterProvider()
  setProvider(
    createProvider({
      id: "openrouter",
      auth: {
        apiKey: {
          name: "OpenRouter via Lore",
          resolve: async () => ({ auth: { apiKey: openRouterApiKey() } }),
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
