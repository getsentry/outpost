// JaredSandbox — extends the Cloudflare Sandbox with outbound interception.
//
// Containers can make HTTP requests to `http://jared.internal/...` which are
// intercepted by Cloudflare's runtime and routed to the outbound handler below.
// This allows container-to-Worker communication without traversing the public
// internet. The handler runs in the ContainerProxy WorkerEntrypoint context
// with access to env bindings (D1, etc.).

import { Sandbox } from "@cloudflare/sandbox"
import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"
import * as dbSchema from "@/db/schema"
import { saveSession } from "./sessions"

export const INTERNAL_HOST = "jared.internal"

export class JaredSandbox extends Sandbox {
  // Intercept outbound HTTP to jared.internal from inside containers.
  // Routes:
  //   POST /sessions/save   — persist agent session data to D1
  //   POST /sessions/done   — agent finished, check if container can self-destruct
  static outboundByHost = {
    [INTERNAL_HOST]: async (
      req: Request,
      env: { DB: D1Database; Sandbox: DurableObjectNamespace },
      ctx: { containerId: string },
    ) => {
      const url = new URL(req.url)
      const path = url.pathname

      if (req.method === "POST" && path === "/sessions/save") {
        try {
          const body = (await req.json()) as { entityKey: string; sessionData: string }
          if (!body.entityKey || !body.sessionData) {
            return new Response(JSON.stringify({ error: "entityKey and sessionData required" }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            })
          }

          const db = drizzle(env.DB, { schema: dbSchema })
          await saveSession(db, body.entityKey, body.sessionData)
          return new Response(JSON.stringify({ ok: true }), {
            headers: { "Content-Type": "application/json" },
          })
        } catch (err) {
          return new Response(JSON.stringify({ error: String(err) }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          })
        }
      }

      if (req.method === "POST" && path === "/sessions/done") {
        try {
          const body = (await req.json()) as { entityKey: string; sessionData?: string }
          if (!body.entityKey) {
            return new Response(JSON.stringify({ error: "entityKey required" }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            })
          }

          const db = drizzle(env.DB, { schema: dbSchema })

          // Save final session data if provided
          if (body.sessionData) {
            await saveSession(db, body.entityKey, body.sessionData)
          }

          // Check if there are pending events for this entity
          const pendingEvents = await db.query.webhookEvents.findFirst({
            where: eq(dbSchema.webhookEvents.entityKey, body.entityKey),
            columns: { id: true },
          })

          // Destroy container if no pending events remain
          const doId = env.Sandbox.idFromString(ctx.containerId)
          const stub = env.Sandbox.get(doId)
          await (stub as unknown as { destroy(): Promise<void> }).destroy()

          return new Response(JSON.stringify({ ok: true, action: "destroyed", hadPending: !!pendingEvents }), {
            headers: { "Content-Type": "application/json" },
          })
        } catch (err) {
          return new Response(JSON.stringify({ error: String(err) }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          })
        }
      }

      return new Response("Not found", { status: 404 })
    },
  }
}
