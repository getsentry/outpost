'use agent'

import { useModel, useSandbox, useSubagent } from "@flue/runtime"
import { local } from "@flue/runtime/node"
import { exploreSubagent } from "./explore.ts"
import { implementSubagent, workerSubagent } from "./implement.ts"
import { JARED_INSTRUCTIONS } from "./instructions.ts"
import { Models } from "./models.ts"
import { shipSubagent } from "./ship.ts"

/**
 * Phase 1: Jared (Opus 4.8) inside the Cloudflare Sandbox via Flue Node + local().
 * Same tiered subagents as the Cloudflare Durable Object build.
 */
export function Jared() {
  useModel(Models.triage)

  useSandbox(
    local({
      cwd: "/workspace/repo",
      env: {
        GH_TOKEN: process.env.GH_TOKEN,
        OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
        ...(process.env.LORE_GATEWAY_URL
          ? { LORE_GATEWAY_URL: process.env.LORE_GATEWAY_URL }
          : {}),
      },
    }),
  )

  useSubagent(exploreSubagent)
  useSubagent(implementSubagent)
  useSubagent(shipSubagent)
  useSubagent(workerSubagent)

  return JARED_INSTRUCTIONS
}

Jared.agentName = "jared"
