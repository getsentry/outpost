import { eq, sql } from "drizzle-orm"
import { Hono } from "hono"
import { afterEach, describe, expect, it, vi } from "vitest"
import { testDb } from "@/__tests__/test-db"
import * as schema from "@/db/schema"
import { toAgentInstanceId } from "@/lib/containers/ids"
import { SessionController } from "@/lib/containers/session-controller"
import type { AuthEnv, BaseEnv } from "@/types"
import router from "../containers"

const getController = vi.hoisted(() => vi.fn())
vi.mock("@/lib/containers/session-controller", async (original) => ({
  ...(await original<typeof import("@/lib/containers/session-controller")>()),
  getSessionController: getController,
}))
const closes: Array<() => void> = []
afterEach(() => {
  for (const close of closes.splice(0)) close()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

async function fixture(authenticated = true) {
  const { db, close } = await testDb()
  closes.push(close)
  const controllers = new Map<string, SessionController>()
  const agent = vi.fn(async (_key: string) => {})
  const sandbox = vi.fn(async (_key: string) => {})
  function controller(key: string) {
    if (!controllers.has(key)) {
      controllers.set(
        key,
        new SessionController(db, key, {
          destroyAgent: () => agent(key),
          destroySandbox: () => sandbox(key),
          prepare: vi.fn(),
          admit: vi.fn(),
        }),
      )
    }
    return controllers.get(key)!
  }
  getController.mockImplementation(async (_env, key: string) => ({
    destroySession: (_key: string, generation: number) => controller(key).destroySession(generation),
  }))
  async function seed(key: string) {
    const generation = await controller(key).startSession()
    const now = new Date()
    await db.insert(schema.webhookEvents).values({
      id: key,
      entityKey: key,
      event: "issues",
      deliveryId: key,
      payload: "{}",
      createdAt: now,
    })
    await db.insert(schema.agentWorkItems).values({
      id: key,
      entityKey: key,
      workKey: key,
      repo: "acme/app",
      sourceKind: "github",
      sourceId: key,
      goal: "test",
      createdAt: now,
      updatedAt: now,
    })
    await db.insert(schema.githubDiscussionObligations).values({
      id: key,
      entityKey: key,
      repo: "acme/app",
      prNumber: 42,
      sourceKind: "review",
      sourceCommentId: key,
      author: "reviewer",
      body: "test",
      eventId: key,
      createdAt: now,
      updatedAt: now,
    })
    return generation
  }
  const app = new Hono<AuthEnv>()
    .use(async (c, next) => {
      c.set("db", db)
      if (authenticated) c.set("user", { id: "operator" } as AuthEnv["Variables"]["user"])
      await next()
    })
    .route("/", router)
  const request = (binding = true, mode = "all") =>
    app.request(`/sessions?mode=${mode}`, { method: "DELETE" }, {
      FLUE_NATIVE: "1",
      ...(binding ? { FLUE_JARED_AGENT: {} } : {}),
    } as BaseEnv["Bindings"])
  return { db, seed, request, agent, sandbox, controller }
}

describe("Clear All runs", () => {
  it("keeps idle clearing records-only and leaves working runs alone", async () => {
    const f = await fixture()
    await f.seed("acme/app#42")
    await f.seed("acme/app#99")
    await f.db
      .update(schema.agentSessions)
      .set({
        sessionData: JSON.stringify({ sessionStatus: { "acme-app-42": { type: "idle" } } }),
      })
      .where(eq(schema.agentSessions.entityKey, "acme/app#42"))
    const response = await f.request(false, "idle")
    expect(await response.json()).toEqual({ ok: true, mode: "idle", deleted: 1, destroyed: 0 })
    expect(getController).not.toHaveBeenCalled()
    expect(f.agent).not.toHaveBeenCalled()
    expect(f.sandbox).not.toHaveBeenCalled()
    expect((await f.db.query.agentSessions.findMany()).map((r) => r.entityKey)).toEqual(["acme/app#99"])
  })

  it("bounds concurrent cleanup and still attempts every selected run", async () => {
    const f = await fixture()
    for (let i = 0; i < 12; i++) await f.seed(`acme/app#${i}`)
    const firstBatch = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let active = 0
    let maximum = 0
    f.agent.mockImplementation(async () => {
      active++
      maximum = Math.max(maximum, active)
      if (active === 5) firstBatch.resolve()
      await release.promise
      active--
    })
    const response = f.request()
    await firstBatch.promise
    expect(f.agent).toHaveBeenCalledTimes(5)
    release.resolve()
    expect((await response).status).toBe(200)
    expect(maximum).toBe(5)
    expect(f.agent).toHaveBeenCalledTimes(12)
  })

  it("deletes durable conversations, sandboxes, and all selected records", async () => {
    const f = await fixture()
    await f.seed("acme/app#42")
    await f.seed("acme/app#99")
    const response = await f.request()
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, deleted: 2, destroyed: 2, failed: [] })
    expect(f.agent.mock.calls.flat().sort()).toEqual(["acme/app#42", "acme/app#99"])
    expect(f.sandbox).toHaveBeenCalledTimes(2)
    for (const table of [
      schema.agentSessions,
      schema.webhookEvents,
      schema.agentWorkItems,
      schema.githubDiscussionObligations,
    ])
      expect(await f.db.select().from(table)).toHaveLength(0)
  })

  it.each([
    "agent",
    "sandbox",
    "records",
  ])("retains failed %s cleanup for per-run retry and reports partial results", async (stage) => {
    const f = await fixture()
    await f.seed("acme/app#42")
    await f.seed("acme/app#99")
    if (stage === "agent" || stage === "sandbox")
      f[stage].mockImplementation(async (key) => {
        if (key === "acme/app#42") throw new Error("private provider details")
      })
    if (stage === "records")
      await f.db.run(sql`CREATE TRIGGER fail_delete BEFORE DELETE ON agent_sessions
      WHEN OLD.entity_key = 'acme/app#42' BEGIN SELECT RAISE(ABORT, 'private provider details'); END`)
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
    const response = await f.request()
    expect(response.status).toBe(207)
    const body = await response.json()
    expect(body).toMatchObject({
      ok: false,
      deleted: 1,
      destroyed: 1,
      deletedKeys: ["acme/app#99"],
      failed: ["acme/app#42"],
    })
    expect(JSON.stringify(body)).not.toContain("private provider")
    expect(warning).toHaveBeenCalledWith("jared: run destruction incomplete", { entityKey: "acme/app#42", stage })
    expect((await f.db.query.agentSessions.findMany()).map((r) => r.entityKey)).toEqual(["acme/app#42"])
    const lifecycle = await f.db.query.agentLifecycle.findMany()
    expect(lifecycle.find((r) => r.instanceId === "acme-app-42")?.cleanupPending).toBe(true)
    await expect(f.controller("acme/app#42").startSession()).rejects.toThrow(/cleanup/)
    f.agent.mockResolvedValue(undefined)
    f.sandbox.mockResolvedValue(undefined)
    if (stage === "records") await f.db.run(sql`DROP TRIGGER fail_delete`)
    await f.controller("acme/app#42").destroySession(1)
    expect(await f.db.query.agentSessions.findMany()).toHaveLength(0)
  })

  it("preserves a new entity created after the bulk snapshot", async () => {
    const f = await fixture()
    await f.seed("acme/app#42")
    f.agent.mockImplementationOnce(async () => {
      await f.seed("acme/app#100")
    })
    expect((await f.request()).status).toBe(200)
    for (const table of [
      schema.agentSessions,
      schema.webhookEvents,
      schema.agentWorkItems,
      schema.githubDiscussionObligations,
    ])
      expect((await f.db.select().from(table)).map((r) => r.entityKey)).toEqual(["acme/app#100"])
  })

  it("does not delete a replacement generation created after the snapshot", async () => {
    const f = await fixture()
    await f.seed("acme/app#42")
    getController.mockImplementationOnce(async (_env, key: string) => {
      await f.controller(key).destroySession(1)
      await f.seed(key)
      return { destroySession: (_key: string, generation: number) => f.controller(key).destroySession(generation) }
    })
    expect((await f.request()).status).toBe(207)
    expect(await f.db.query.agentSessions.findMany()).toHaveLength(1)
    expect(await f.db.query.agentLifecycle.findFirst()).toMatchObject({ generation: 2, destroyedAt: null })
    expect(f.agent).toHaveBeenCalledTimes(1)
  })

  it("supports legacy runs with no lifecycle row", async () => {
    const f = await fixture()
    const now = new Date()
    await f.db
      .insert(schema.agentSessions)
      .values({ entityKey: "legacy/key", sessionData: "{}", createdAt: now, updatedAt: now })
    expect((await f.request()).status).toBe(200)
    expect(await f.db.query.agentLifecycle.findFirst()).toMatchObject({
      instanceId: toAgentInstanceId("legacy/key"),
      cleanupPending: false,
    })
    expect(f.agent).toHaveBeenCalledWith("legacy/key")
  })

  it("fails before cleanup if the lifecycle binding is missing", async () => {
    const f = await fixture()
    await f.seed("acme/app#42")
    expect((await f.request(false)).status).toBe(503)
    expect(getController).not.toHaveBeenCalled()
    expect(await f.db.query.agentSessions.findMany()).toHaveLength(1)
  })

  it("requires authentication", async () => {
    const f = await fixture(false)
    await f.seed("acme/app#42")
    expect((await f.request()).status).toBe(401)
    expect(getController).not.toHaveBeenCalled()
  })

  it("handles an empty selection without invoking cleanup", async () => {
    const f = await fixture()
    expect(await (await f.request()).json()).toMatchObject({ ok: true, deletedKeys: [], failed: [], deleted: 0 })
    expect(getController).not.toHaveBeenCalled()
  })
})
