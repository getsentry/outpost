import { eq } from "drizzle-orm"
import { afterEach, describe, expect, it } from "vitest"
import { testDb } from "@/__tests__/test-db"
import { agentSessions } from "@/db/schema"
import { destroyAgentGeneration, startAgentGeneration } from "@/lib/agents/lifecycle"
import { saveSession } from "../sessions"

const entityKey = "acme/app#42"
const instanceId = "acme-app-42"
const history = (text: string) =>
  JSON.stringify({
    sessions: [{ id: instanceId }],
    messages: { [instanceId]: [{ info: { id: text, role: "assistant" }, parts: [{ type: "text", text }] }] },
  })
const closes: Array<() => void> = []
afterEach(() => {
  for (const close of closes.splice(0)) close()
})

describe("destroyed session persistence", () => {
  it("does not resurrect a deleted session when an old history read completes", async () => {
    const { db, close } = await testDb()
    closes.push(close)
    const generation = await startAgentGeneration(db, instanceId)
    await saveSession(db, entityKey, history("old"), generation)
    await destroyAgentGeneration(db, instanceId)
    await db.delete(agentSessions).where(eq(agentSessions.entityKey, entityKey))

    await saveSession(db, entityKey, history("late"), generation)

    expect(await db.query.agentSessions.findFirst()).toBeUndefined()
  })

  it("does not merge old history into a newly started generation", async () => {
    const { db, close } = await testDb()
    closes.push(close)
    const oldGeneration = await startAgentGeneration(db, instanceId)
    await destroyAgentGeneration(db, instanceId)
    const currentGeneration = await startAgentGeneration(db, instanceId)
    await saveSession(db, entityKey, history("new"), currentGeneration)

    await saveSession(db, entityKey, history("old"), oldGeneration)

    const row = await db.query.agentSessions.findFirst()
    expect(row?.sessionData).toContain('"new"')
    expect(row?.sessionData).not.toContain('"old"')
  })
})
