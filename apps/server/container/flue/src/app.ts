import { createAgentRouter } from "@flue/runtime/routing"
import { Hono } from "hono"
import { Jared } from "./agents/jared.ts"
import { registerLoreOpenRouterProvider } from "./lore-provider.ts"

registerLoreOpenRouterProvider()

/**
 * Phase 1 in-container Flue route map.
 * Conversations live at /agents/jared/:conversationId
 *
 * This surface is localhost-only inside the sandbox (not the public Worker).
 */
const app = new Hono()

app.get("/api/ping", (c) => c.json({ ok: true, harness: "flue", agent: "jared" }))
app.get("/health", (c) => c.json({ status: "ok" }))

app.route("/agents/jared", createAgentRouter(Jared))

export default app
