// JSON API routes for the external dashboard SPA.
// All routes live under /api/* and require a Bearer token
// matching OPENTOWER_API_TOKEN (env var).

import type { Context } from "hono"
import type { LifecycleStore } from "../storage"

export type ApiEnv = {
  Variables: {
    store: LifecycleStore
  }
}

export function apiStatsHandler(c: Context<ApiEnv>) {
  const store = c.get("store")
  return c.json(store.getStats())
}

export function apiEntitiesHandler(c: Context<ApiEnv>) {
  const store = c.get("store")
  const limit = Number(c.req.query("limit") || "50")
  const cursor = c.req.query("cursor") || undefined
  const repo = c.req.query("repo") || undefined
  return c.json(store.listEntities({ limit, cursor, repo }))
}

export function apiEntityDetailHandler(c: Context<ApiEnv>) {
  const store = c.get("store")
  const key = decodeURIComponent(c.req.param("key") ?? "")
  const entity = store.getEntity(key)
  if (!entity) return c.json({ error: "entity not found" }, 404)
  const dispatches = store.getEntityDispatches(key)
  const links = store.getEntityLinks(key)
  return c.json({ entity, dispatches, links })
}

export function apiDispatchesHandler(c: Context<ApiEnv>) {
  const store = c.get("store")
  const limit = Number(c.req.query("limit") || "50")
  const cursor = c.req.query("cursor") || undefined
  const status = c.req.query("status") || undefined
  const event = c.req.query("event") || undefined
  return c.json(store.listDispatches({ limit, cursor, status, event }))
}
