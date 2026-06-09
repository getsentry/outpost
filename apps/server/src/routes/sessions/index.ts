import { desc, eq, sql } from "drizzle-orm"
import { Hono } from "hono"
import { webhookEvents } from "@/db/schema"
import { isAuthenticated } from "@/middlewares"
import type { AuthEnv } from "@/types"

// Agent sessions are derived from dispatched webhook events.
// Each unique entity_key with dispatched events represents an active agent session.

const router = new Hono<AuthEnv>()
  .use(isAuthenticated())
  .get("/", async (c) => {
    const db = c.get("db")

    const page = Math.max(1, Number(c.req.query("page")) || 1)
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 25))
    const offset = (page - 1) * limit

    // Group dispatched events by entity_key to show active sessions
    const [sessions, countResult] = await Promise.all([
      db
        .select({
          entityKey: webhookEvents.entityKey,
          repo: webhookEvents.repo,
          eventCount: sql<number>`count(*)`,
          lastEvent: sql<string>`max(${webhookEvents.event} || '.' || coalesce(${webhookEvents.action}, ''))`,
          createdAt: sql<string>`min(${webhookEvents.createdAt})`,
          updatedAt: sql<string>`max(${webhookEvents.createdAt})`,
        })
        .from(webhookEvents)
        .where(eq(webhookEvents.status, "dispatched"))
        .groupBy(webhookEvents.entityKey, webhookEvents.repo)
        .orderBy(sql`max(${webhookEvents.createdAt}) desc`)
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(distinct ${webhookEvents.entityKey})` })
        .from(webhookEvents)
        .where(eq(webhookEvents.status, "dispatched")),
    ])

    const total = countResult[0]?.count ?? 0

    return c.json({
      data: sessions,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    })
  })
  .get("/:entityKey", async (c) => {
    const db = c.get("db")
    const entityKey = decodeURIComponent(c.req.param("entityKey"))

    // Get all dispatched events for this entity
    const events = await db
      .select({
        id: webhookEvents.id,
        event: webhookEvents.event,
        action: webhookEvents.action,
        sender: webhookEvents.sender,
        status: webhookEvents.status,
        createdAt: webhookEvents.createdAt,
        dispatchedAt: webhookEvents.dispatchedAt,
      })
      .from(webhookEvents)
      .where(eq(webhookEvents.entityKey, entityKey))
      .orderBy(desc(webhookEvents.createdAt))
      .limit(50)

    if (events.length === 0) {
      return c.json({ error: "Session not found" }, 404)
    }

    return c.json({
      entityKey,
      repo: events[0]?.sender ? undefined : undefined, // repo from first event
      events,
    })
  })

export default router
