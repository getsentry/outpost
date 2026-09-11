import { sql } from "drizzle-orm"
import { Hono } from "hono"
import { afterEach, describe, expect, it, vi } from "vitest"
import { testDb } from "@/__tests__/test-db"
import { agentSessions } from "@/db/schema"
import { startAgentGeneration } from "@/lib/agents/lifecycle"
import { SessionController } from "@/lib/containers/session-controller"
import { mintSessionIngestToken } from "@/lib/containers/session-ingest-token"
import { saveSession } from "@/lib/containers/sessions"
import type { AuthEnv, BaseEnv } from "@/types"
import router from "../containers"

const sandboxDestroy = vi.hoisted(() => vi.fn(async () => {}))
const historyRead = vi.hoisted(() => vi.fn())
const getController = vi.hoisted(() => vi.fn())
vi.mock("@/lib/containers/session-controller", async (original) => ({
  ...(await original<typeof import("@/lib/containers/session-controller")>()),
  getSessionController: getController,
}))
vi.mock("@cloudflare/sandbox", () => ({ getSandbox: () => ({ destroy: sandboxDestroy }) }))
vi.mock("@/lib/containers/flue-dispatch", async (original) => ({
  ...(await original<typeof import("@/lib/containers/flue-dispatch")>()),
  fetchFlueHistoryResult: historyRead,
}))

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
    get: vi.fn((_id: string) => ({ destroy: durableDestroy })),
  }
  sandboxDestroy.mockResolvedValue(undefined)
  const controller = new SessionController(db, "acme/app#42", {
    destroyAgent: async () => {
      await binding.get(binding.idFromName("acme-app-42")).destroy()
    },
    destroySandbox: sandboxDestroy,
    prepare: vi.fn(),
    admit: vi.fn(),
  })
  getController.mockResolvedValue({
    destroySession: (_: string, generation: number) => controller.destroySession(generation),
  })
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
  const detail = () =>
    app.request("/sessions/detail?entityKey=acme%2Fapp%2342", {}, { FLUE_NATIVE: "1" } as BaseEnv["Bindings"])
  const list = () => app.request("/sessions", {}, {} as BaseEnv["Bindings"])
  const streamSnapshot = () => {
    // Seed one snapshot, then end the test stream instead of entering its long-poll loop.
    const abort = new AbortController()
    abort.abort()
    return app.request("/sessions/stream?entityKey=acme%2Fapp%2342", { signal: abort.signal }, {
      FLUE_NATIVE: "1",
    } as BaseEnv["Bindings"])
  }
  const ingest = (token: string, text: string) =>
    app.request(
      "/sessions",
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          entityKey: "acme/app#42",
          sessionData: JSON.stringify({ messages: { m: [{ text }] } }),
        }),
      },
      { FLUE_INTERNAL_TOKEN: "test-secret" } as BaseEnv["Bindings"],
    )
  return { request, detail, list, streamSnapshot, ingest, db, durableDestroy, binding }
}

describe("Destroy run", () => {
  it.each([
    "agent",
    "sandbox",
    "records",
  ])("logs the %s cleanup stage without leaking provider details", async (stage) => {
    const f = await fixture()
    if (stage === "agent") f.durableDestroy.mockRejectedValueOnce(new Error("private provider detail"))
    if (stage === "sandbox") sandboxDestroy.mockRejectedValueOnce(new Error("private provider detail"))
    if (stage === "records")
      await f.db.run(sql`CREATE TRIGGER fail_delete BEFORE DELETE ON agent_sessions
      BEGIN SELECT RAISE(ABORT, 'private provider detail'); END`)
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const response = await f.request()
      expect(response.status).toBe(503)
      expect(warning).toHaveBeenCalledWith("jared: run destruction incomplete", { entityKey: "acme/app#42", stage })
      expect(JSON.stringify(warning.mock.calls)).not.toContain("private provider detail")
      expect(await response.text()).not.toContain("private provider detail")
    } finally {
      warning.mockRestore()
    }
  })

  it("does not return a stale D1 fallback when history fails after deletion", async () => {
    const f = await fixture()
    historyRead.mockImplementationOnce(async () => {
      expect((await f.request()).status).toBe(200)
      return { ok: false, error: "history unavailable" }
    })
    expect((await f.detail()).status).toBe(410)
  })
  it("rejects an old reporter token after restart without changing the new history", async () => {
    const f = await fixture()
    const oldGeneration = await startAgentGeneration(f.db, "acme-app-42")
    const oldToken = await mintSessionIngestToken("test-secret", "acme/app#42", oldGeneration)
    expect((await f.ingest(oldToken, "old")).status).toBe(200)
    expect((await f.request()).status).toBe(200)
    const generation = await startAgentGeneration(f.db, "acme-app-42")
    const newToken = await mintSessionIngestToken("test-secret", "acme/app#42", generation)
    expect((await f.ingest(newToken, "new")).status).toBe(200)
    expect((await f.ingest(oldToken, "old")).status).toBe(401)
    const rows = await f.db.query.agentSessions.findMany()
    expect(rows.find((row) => row.entityKey === "acme/app#42")?.sessionData).not.toContain('"old"')
  })
  it("does not return a late history response after the run was destroyed", async () => {
    const f = await fixture()
    historyRead.mockImplementationOnce(async () => {
      expect((await f.request()).status).toBe(200)
      return { ok: true, history: { messages: [{ role: "assistant", body: "old response" }] } }
    })
    expect((await f.detail()).status).toBe(410)
    expect((await f.db.query.agentSessions.findMany()).map((row) => row.entityKey)).toEqual(["acme/app#99"])
  })

  it("does not return or persist old history after an explicit new generation starts", async () => {
    const f = await fixture()
    await startAgentGeneration(f.db, "acme-app-42")
    historyRead.mockImplementationOnce(async () => {
      expect((await f.request()).status).toBe(200)
      const generation = await startAgentGeneration(f.db, "acme-app-42")
      await saveSession(
        f.db,
        "acme/app#42",
        JSON.stringify({ messages: { fresh: [{ text: "new response" }] } }),
        generation,
      )
      return { ok: true, history: { messages: [{ role: "assistant", body: "old response" }] } }
    })
    expect((await f.detail()).status).toBe(410)
    const rows = await f.db.query.agentSessions.findMany()
    expect(rows.find((row) => row.entityKey === "acme/app#42")?.sessionData).not.toContain("old response")
  })

  it("reports database cleanup failure and allows the operator to retry", async () => {
    const f = await fixture()
    await f.db.run(sql`CREATE TRIGGER fail_delete BEFORE DELETE ON agent_sessions
      BEGIN SELECT RAISE(ABORT, 'temporary test failure'); END`)
    expect((await f.request()).status).toBe(503)
    expect(await f.db.query.agentSessions.findMany()).toHaveLength(2)
    await f.db.run(sql`DROP TRIGGER fail_delete`)
    expect((await f.request()).status).toBe(200)
    expect((await f.db.query.agentSessions.findMany()).map((row) => row.entityKey)).toEqual(["acme/app#99"])
  })

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
    const detail = await f.detail()
    expect(detail.status).toBe(200)
    expect(await detail.json()).toMatchObject({ status: "cleanup_pending", cleanupPending: true })
    const list = await f.list()
    expect(
      (await list.json()).data.find((row: { entityKey: string }) => row.entityKey === "acme/app#42"),
    ).toMatchObject({ status: "cleanup_pending", activityPreview: { state: "cleanup_pending" } })
    const stream = await f.streamSnapshot()
    expect(stream.status).toBe(200)
    const frame = await stream.text()
    expect(frame).toContain("event: snapshot")
    const data = frame
      .split("\n")
      .find((line) => line.startsWith("data: "))
      ?.slice(6)
    expect(JSON.parse(data ?? "{}")).toMatchObject({ status: "cleanup_pending", cleanupPending: true })
    expect(historyRead).not.toHaveBeenCalled()
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
