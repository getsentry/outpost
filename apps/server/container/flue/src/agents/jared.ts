'use agent'

import { useModel, useSandbox, useSubagent } from "@flue/runtime"
import { local } from "@flue/runtime/node"
import { exploreSubagent } from "./explore.ts"
import { JARED_INSTRUCTIONS } from "./instructions.ts"
import { workerSubagent } from "./worker.ts"

/**
 * Phase 1: Jared running inside the Cloudflare Sandbox container via Flue's
 * Node target + local() sandbox (the container IS the isolation boundary).
 */
export function Jared() {
  useModel("openrouter/anthropic/claude-opus-4.8")

  useSandbox(
    local({
      cwd: "/workspace/repo",
      env: {
        GH_TOKEN: process.env.GH_TOKEN,
        OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
        // Lore gateway (when running in-container)
        ...(process.env.LORE_GATEWAY_URL
          ? { LORE_GATEWAY_URL: process.env.LORE_GATEWAY_URL }
          : {}),
      },
    }),
  )

  useSubagent(exploreSubagent)
  useSubagent(workerSubagent)

  return JARED_INSTRUCTIONS
}

Jared.agentName = "jared"
