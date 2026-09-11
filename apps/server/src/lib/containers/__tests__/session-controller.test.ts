import { afterEach, describe, expect, it, vi } from "vitest"
import { testDb } from "@/__tests__/test-db"
import { startAgentGeneration } from "@/lib/agents/lifecycle"
import { SessionController } from "../session-controller"

const entityKey = "acme/app#42"
const instanceId = "acme-app-42"
const closes: Array<() => void> = []
afterEach(() => {
  for (const close of closes.splice(0)) close()
})
async function fixture() {
  const { db, close } = await testDb()
  closes.push(close)
  const dependencies = {
    destroyAgent: vi.fn(async () => {}),
    destroySandbox: vi.fn(async () => {}),
    prepare: vi.fn(async () => {}),
    admit: vi.fn(async () => ({ submissionId: "receipt" })),
  }
  const controller = new SessionController(db, entityKey, dependencies)
  const generation = await controller.startSession()
  return { db, dependencies, controller, generation }
}

describe("session lifecycle owner", () => {
  it("cannot restart from a resend whose source event was removed by Destroy", async () => {
    const f = await fixture()
    await f.controller.recordSessionEvent(f.generation, {
      id: "event",
      entityKey,
      event: "issues",
      deliveryId: "delivery",
      payload: "{}",
      status: "pending",
      createdAt: new Date(),
    })
    expect(await f.controller.startSession("event")).toBe(f.generation)
    await f.controller.destroySession(f.generation)
    await expect(f.controller.startSession("event")).rejects.toThrow(/event/i)
    expect(await f.db.query.agentSessions.findMany()).toHaveLength(0)
  })
  it("orders cleanup after in-flight preparation and rejects its late admission", async () => {
    const f = await fixture()
    const entered = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    f.dependencies.prepare.mockImplementationOnce(async () => {
      entered.resolve()
      await finish.promise
    })
    const preparing = f.controller.prepareSession(f.generation, {
      entityKey,
      repo: "acme/app",
      botLogin: "bot",
      installationToken: "test",
    })
    await entered.promise
    const deleting = f.controller.destroySession(f.generation)
    expect(f.dependencies.destroyAgent).not.toHaveBeenCalled()
    finish.resolve()
    await preparing
    await deleting
    await expect(f.controller.admitSession(f.generation, { kind: "user", body: "old" }, {})).rejects.toThrow(
      /destroyed/,
    )
    expect(f.dependencies.admit).not.toHaveBeenCalled()
    expect(await f.db.query.agentSessions.findMany()).toHaveLength(0)
  })

  it("rejects old preparation and work inserts after a new generation starts", async () => {
    const f = await fixture()
    await f.controller.destroySession(f.generation)
    const current = await f.controller.startSession()
    expect(current).toBe(f.generation + 1)
    await expect(
      f.controller.prepareSession(f.generation, {
        entityKey,
        repo: "acme/app",
        botLogin: "bot",
        installationToken: "test",
      }),
    ).rejects.toThrow(/destroyed/)
    await expect(
      f.controller.recordSessionWork(f.generation, {
        entityKey,
        workKey: entityKey,
        repo: "acme/app",
        sourceId: "late",
        sourceKind: "dashboard",
        goal: "old task",
      }),
    ).rejects.toThrow(/destroyed/)
    expect(f.dependencies.prepare).not.toHaveBeenCalled()
    expect(await f.db.query.agentWorkItems.findMany()).toHaveLength(0)
    await expect(f.controller.admitSession(current, { kind: "user", body: "new" }, {})).resolves.toEqual({
      submissionId: "receipt",
    })
  })

  it("keeps failed cleanup fenced across coordinator restarts and permits a successful retry", async () => {
    const f = await fixture()
    f.dependencies.destroySandbox.mockRejectedValueOnce(new Error("temporary"))
    await expect(f.controller.destroySession(f.generation)).rejects.toMatchObject({
      message: "Run cleanup failed during sandbox deletion",
      cause: new Error("temporary"),
    })
    await expect(startAgentGeneration(f.db, instanceId)).rejects.toThrow(/cleanup/)
    const restarted = new SessionController(f.db, entityKey, f.dependencies)
    await expect(restarted.startSession()).rejects.toThrow(/cleanup/)
    await restarted.destroySession(f.generation)
    expect(await restarted.startSession()).toBe(f.generation + 1)
  })

  it("does not let duplicate cleanup delete a new run", async () => {
    const f = await fixture()
    await Promise.all([f.controller.destroySession(f.generation), f.controller.destroySession(f.generation)])
    expect(f.dependencies.destroyAgent).toHaveBeenCalledTimes(2)
    const next = await f.controller.startSession()
    await expect(f.controller.destroySession(f.generation)).rejects.toThrow(/changed/)
    expect(f.dependencies.destroyAgent).toHaveBeenCalledTimes(2)
    expect(await f.db.query.agentSessions.findMany()).toHaveLength(1)
    expect(next).toBe(f.generation + 1)
  })

  it("serializes an admitted request before cleanup", async () => {
    const f = await fixture()
    const entered = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    f.dependencies.admit.mockImplementationOnce(async () => {
      entered.resolve()
      await finish.promise
      return { submissionId: "receipt" }
    })
    const admitting = f.controller.admitSession(f.generation, { kind: "user", body: "old" }, {})
    await entered.promise
    const deleting = f.controller.destroySession(f.generation)
    expect(f.dependencies.destroyAgent).not.toHaveBeenCalled()
    finish.resolve()
    await admitting
    await deleting
    expect(f.dependencies.destroyAgent).toHaveBeenCalledOnce()
  })
})
