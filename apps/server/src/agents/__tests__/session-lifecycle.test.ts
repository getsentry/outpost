import { env } from "cloudflare:workers"
import { afterEach, describe, expect, it, vi } from "vitest"
import { testDb } from "@/__tests__/test-db"
import type { SessionControllerRpc } from "@/lib/containers/session-controller"
import { cloudflare } from "../jared"

const fixture = vi.hoisted(() => ({ db: undefined as unknown }))
const prepare = vi.hoisted(() => vi.fn(async () => {}))
const destroyAgent = vi.hoisted(() => vi.fn(async () => {}))
const destroySandbox = vi.hoisted(() => vi.fn(async () => {}))
const fetchAgent = vi.hoisted(() =>
  vi.fn(async (_request: Request) => Response.json({ submissionId: "accepted" }, { status: 202 })),
)
const namedAgent = vi.hoisted(() => vi.fn(async (_binding: unknown, _name: string) => ({ fetch: fetchAgent })))
vi.mock("drizzle-orm/d1", () => ({ drizzle: () => fixture.db }))
vi.mock("agents", () => ({ getAgentByName: namedAgent }))
vi.mock("@flue/runtime/cloudflare", () => ({ extend: (extension: unknown) => extension, cloudflareSandbox: vi.fn() }))
vi.mock("@cloudflare/sandbox", () => ({ getSandbox: () => ({ destroy: destroySandbox }) }))
vi.mock("@/agents/sentry.ts", () => ({}))
vi.mock("@/lib/containers/dispatch", async (original) => ({
  ...(await original<typeof import("@/lib/containers/dispatch")>()),
  ensureSandboxReady: prepare,
}))

class FakeBase {
  name = "lifecycle:acme-app-42"
  schedule = vi.fn(async (_delay: number, _callback: string, _payload: unknown) => {})
  async destroy() {
    await destroyAgent()
  }
}
const Agent = cloudflare.base!(FakeBase as never) as unknown as new () => FakeBase &
  SessionControllerRpc & {
    scheduleFollowUp(delay: number, prompt: string): Promise<void>
  }
const closes: Array<() => void> = []
afterEach(() => {
  for (const close of closes.splice(0)) close()
  vi.clearAllMocks()
})
async function setup() {
  const { db, close } = await testDb()
  closes.push(close)
  fixture.db = db
  Object.assign(env, {
    DB: {},
    FLUE_NATIVE: "1",
    FLUE_JARED_AGENT: {
      idFromName: (id: string) => id,
      get: () => ({ prepareDestroy: async () => {}, destroy: destroyAgent, isDestroyComplete: async () => true }),
    },
  })
  return { db, agent: new Agent() }
}

describe("Cloudflare session lifecycle extension", () => {
  it("routes generation-scoped preparation and HTTP admission to the canonical agent", async () => {
    const { agent, db } = await setup()
    const key = "acme/app#42"
    const generation = await agent.startSession(key)
    const options = { entityKey: key, repo: "acme/app", botLogin: "bot", installationToken: "test" }
    await agent.prepareSession(key, generation, options)
    expect(prepare).toHaveBeenCalledWith(expect.anything(), options)
    await expect(
      agent.admitSession(key, generation, { kind: "user", body: "hello" }, { traceparent: "test-trace" }),
    ).resolves.toEqual({ submissionId: "accepted" })
    expect(namedAgent).toHaveBeenCalledWith(expect.anything(), "acme-app-42")
    const request = fetchAgent.mock.calls[0][0]
    expect(request.url).toBe("https://flue.internal/agents/jared/acme-app-42")
    expect(request.headers.get("traceparent")).toBe("test-trace")
    expect(await request.json()).toEqual({ kind: "user", body: "hello" })
    await agent.destroySession(key, generation)
    expect(destroyAgent).toHaveBeenCalledOnce()
    expect(destroySandbox).toHaveBeenCalledOnce()
    expect(await db.query.agentSessions.findMany()).toHaveLength(0)
    await expect(agent.admitSession(key, generation, { kind: "user", body: "late" }, {})).rejects.toThrow(/destroyed/)
    expect(fetchAgent).toHaveBeenCalledOnce()
  })

  it("rejects lifecycle RPCs on the conversation itself", async () => {
    const { agent } = await setup()
    agent.name = "acme-app-42"
    expect(() => agent.startSession("acme/app#42")).toThrow("Invalid lifecycle owner")
  })

  it("waits for active scheduling before SDK destruction and refuses further schedules", async () => {
    const { agent } = await setup()
    await agent.startSession("acme/app#42")
    agent.name = "acme-app-42"
    const entered = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    agent.schedule.mockImplementationOnce(async () => {
      entered.resolve()
      await finish.promise
    })
    const scheduling = agent.scheduleFollowUp(60, "follow up")
    await entered.promise
    const deleting = agent.destroy()
    expect(destroyAgent).not.toHaveBeenCalled()
    finish.resolve()
    await scheduling
    await deleting
    expect(destroyAgent).toHaveBeenCalledOnce()
    await expect(agent.scheduleFollowUp(60, "late")).rejects.toThrow(/destroyed/)
  })
})
