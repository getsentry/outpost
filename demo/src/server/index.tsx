import { Hono } from "hono"

const app = new Hono<{ Bindings: Env }>()

app.get("/status", (c) => c.json({ status: "ok" }))

// All other routes (including "/") are served by the SPA assets via the
// `not_found_handling: "single-page-application"` setting in wrangler.jsonc.

export default app
