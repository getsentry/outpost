import { Hono } from "hono"
import { afterEach, describe, expect, it } from "vitest"
import { testDb } from "@/__tests__/test-db"
import * as schema from "@/db/schema"
import type { AuthEnv } from "@/types"
import eventsRouter from "../events"

const closes: Array<() => void> = []
afterEach(() => {
  for (const close of closes.splice(0)) close()
})

async function fixture() {
  const { db, close } = await testDb()
  closes.push(close)
  const now = Math.floor(Date.now() / 1000)
  const at = (secondsAgo: number) => new Date((now - secondsAgo) * 1000)
  await db.insert(schema.webhookEvents).values([
    {
      id: "recent",
      entityKey: "acme/app#1",
      event: "issues",
      deliveryId: "recent",
      payload: "{}",
      createdAt: at(30 * 60),
    },
    {
      id: "hours",
      entityKey: "acme/app#2",
      event: "issues",
      deliveryId: "hours",
      payload: "{}",
      createdAt: at(3 * 60 * 60),
    },
    {
      id: "old",
      entityKey: "acme/app#3",
      event: "issues",
      deliveryId: "old",
      payload: "{}",
      createdAt: at(3 * 24 * 60 * 60),
    },
  ])
  const app = new Hono<AuthEnv>()
    .use(async (c, next) => {
      c.set("db", db)
      c.set("user", { id: "operator" } as AuthEnv["Variables"]["user"])
      await next()
    })
    .route("/", eventsRouter)
  const list = async (query = "") => {
    const res = await app.request(`/${query}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Array<{ id: string }>; pagination: { total: number } }
    return body
  }
  return { list, now }
}

describe("GET /events time range filtering", () => {
  it("returns all events without a from/to window", async () => {
    const f = await fixture()
    const body = await f.list()
    expect(body.pagination.total).toBe(3)
  })

  it("filters to events after `from`", async () => {
    const f = await fixture()
    const oneHourAgo = f.now - 60 * 60
    const body = await f.list(`?from=${oneHourAgo}`)
    expect(body.data.map((e) => e.id)).toEqual(["recent"])
    expect(body.pagination.total).toBe(1)
  })

  it("filters within a from/to window", async () => {
    const f = await fixture()
    const sixHoursAgo = f.now - 6 * 60 * 60
    const oneHourAgo = f.now - 60 * 60
    const body = await f.list(`?from=${sixHoursAgo}&to=${oneHourAgo}`)
    expect(body.data.map((e) => e.id)).toEqual(["hours"])
    expect(body.pagination.total).toBe(1)
  })

  it("ignores non-numeric from/to values", async () => {
    const f = await fixture()
    const body = await f.list("?from=notanumber")
    expect(body.pagination.total).toBe(3)
  })
})
