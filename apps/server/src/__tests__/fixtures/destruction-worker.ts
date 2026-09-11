import { DurableObject } from "cloudflare:workers"
import { Agent, getAgentByName } from "agents"
import { cloudflare } from "../../agents/jared"
import { getSessionController } from "../../lib/containers/session-controller"
import type { BaseEnvBindings } from "../../types/env/base"

const key = "acme/app#42"
const id = "acme-app-42"
// Flue narrows the extension type, but the runtime base is the real SDK Agent.
const Base = cloudflare.base!(Agent as never) as unknown as typeof Agent

export class TestAgent extends Base {
  async seed() {
    await this.ctx.storage.put("history", "old conversation")
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS test_history (message TEXT)")
    this.ctx.storage.sql.exec("INSERT INTO test_history VALUES ('old conversation')")
    await this.schedule(600, "scheduledWork", {})
  }

  async snapshot() {
    const table = this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'test_history'").toArray()
    return {
      history: (await this.ctx.storage.get("history")) ?? null,
      historyTable: table.length > 0,
      alarm: await this.ctx.storage.getAlarm(),
    }
  }

  async scheduledWork() {}

  async destroy() {
    const mode = await this.ctx.storage.get<string>("failure-mode")
    if (mode === "before-delete") throw new Error("destroyed")
    if (mode === "without-delete") return
    if (mode === "without-reset") {
      await this.ctx.storage.deleteAlarm()
      await this.ctx.storage.deleteAll()
      return
    }
    if (mode === "reset-before-delete") {
      this.ctx.abort("destroyed")
    }
    await super.destroy()
    if (mode === "normal-reply") return
    // Keep the RPC reply open until the real SDK's scheduled ctx.abort fires.
    // A normal resolved mock cannot reproduce this production failure.
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  async setFailureMode(mode: string) {
    await this.ctx.storage.put("failure-mode", mode)
  }
}

export class TestSandbox extends DurableObject {
  async configure() {}
  async destroy() {
    await this.ctx.storage.put("destroyed", true)
  }
  async wasDestroyed() {
    return (await this.ctx.storage.get("destroyed")) === true
  }
}

export default {
  async fetch(request: Request, env: BaseEnvBindings["Bindings"]) {
    const url = new URL(request.url)
    const agent = (await getAgentByName(env.FLUE_JARED_AGENT!, id)) as unknown as TestAgent
    if (url.pathname === "/seed") {
      const owner = await getSessionController(env, key)
      const generation = await owner.startSession(key)
      await agent.seed()
      await agent.setFailureMode(url.searchParams.get("mode") ?? "after-delete")
      return Response.json({ generation })
    }
    if (url.pathname === "/destroy") {
      try {
        const owner = await getSessionController(env, key)
        await owner.destroySession(key, 1)
        return Response.json({ ok: true })
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 503 })
      }
    }
    if (url.pathname === "/recover") {
      await agent.setFailureMode("after-delete")
      return Response.json({ ok: true })
    }
    const sandbox = env.Sandbox.get(env.Sandbox.idFromName(id)) as unknown as TestSandbox
    return Response.json({ ...(await agent.snapshot()), sandboxDestroyed: await sandbox.wasDestroyed() })
  },
}
