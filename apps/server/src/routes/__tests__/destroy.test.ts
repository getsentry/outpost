import { Hono } from "hono"
import { afterEach, describe, expect, it, vi } from "vitest"
import { testDb } from "@/__tests__/test-db"
import { agentSessions } from "@/db/schema"
import type { AuthEnv, BaseEnv } from "@/types"
import router from "../containers"

const sandboxDestroy = vi.hoisted(() => vi.fn(async () => {}))
vi.mock("@cloudflare/sandbox", () => ({ getSandbox: () => ({ destroy: sandboxDestroy }) }))

const closes: Array<() => void> = []
afterEach(() => {
  for (const close of closes.splice(0)) close()
  vi.clearAllMocks()
})

async function fixture(authenticated = true) {
  const { db, close } = await testDb()
  closes.push(close)
  const now = new Date()
  await db.insert(agentSessions).values([
    { entityKey: "acme/app#42", sessionData: "{}", createdAt: now, updatedAt: now },
    { entityKey: "acme/app#99", sessionData: "{}", createdAt: now, updatedAt: now },
  ])
  const durableDestroy = vi.fn(async () => {})
  const binding = {
    idFromName: vi.fn((id: string) => id),
    get: vi.fn(() => ({ destroy: durableDestroy })),
  }
  sandboxDestroy.mockResolvedValue(undefined)
  const app = new Hono<AuthEnv>()
    .use(async (c, next) => {
      c.set("db", db)
      if (authenticated) c.set("user", { id: "operator" } as AuthEnv["Variables"]["user"])
      await next()
    })
    .route("/", router)
  const request = (bindings: Record<string, unknown> = { FLUE_JARED_AGENT: binding }) =>
    app.request("/acme%2Fapp%2342/destroy", { method: "POST" }, {
      FLUE_NATIVE: "1",
      ...bindings,
    } as unknown as BaseEnv["Bindings"])
  return { request, db, durableDestroy, binding }
}

describe("Destroy run", () => {
  it("destroys the canonical durable conversation as well as its sandbox and session row", async () => {
    const f = await fixture()
    expect((await f.request()).status).toBe(200)
    expect(f.binding.idFromName).toHaveBeenCalledWith("acme-app-42")
    expect(f.durableDestroy).toHaveBeenCalledOnce()
    expect(sandboxDestroy).toHaveBeenCalledOnce()
    expect((await f.db.query.agentSessions.findMany()).map((row) => row.entityKey)).toEqual(["acme/app#99"])
  })

  it("does not claim success or remove the retryable session if durable cleanup fails", async () => {
    const f = await fixture()
    f.durableDestroy.mockRejectedValueOnce(new Error("provider detail must stay private"))
    const response = await f.request()
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain("provider detail")
    expect(await f.db.query.agentSessions.findMany()).toHaveLength(2)
  })

  it("does not silently fall back to sandbox-only deletion when the native binding is missing", async () => {
    const f = await fixture()
    expect((await f.request({})).status).toBe(503)
    expect(sandboxDestroy).not.toHaveBeenCalled()
    expect(await f.db.query.agentSessions.findMany()).toHaveLength(2)
  })

  it("does not claim success if stopping the sandbox fails", async () => {
    const f = await fixture()
    sandboxDestroy.mockRejectedValueOnce(new Error("sandbox unavailable"))
    expect((await f.request()).status).toBe(503)
    expect(await f.db.query.agentSessions.findMany()).toHaveLength(2)
  })

  it("requires authentication before any teardown", async () => {
    const f = await fixture(false)
    expect((await f.request()).status).toBe(401)
    expect(f.durableDestroy).not.toHaveBeenCalled()
    expect(sandboxDestroy).not.toHaveBeenCalled()
  })
})
