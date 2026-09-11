import { DurableObject } from "cloudflare:workers"
import { getSandbox as getCloudflareSandbox, type Sandbox } from "@cloudflare/sandbox"
import { freshRpc } from "../../lib/containers/fresh-rpc"
import { getSandbox } from "../../lib/containers/sandbox-client"

export class ResettableSandbox extends DurableObject {
  async configure(configuration: Record<string, unknown>) {
    await this.ctx.storage.put("configuration", configuration)
  }

  async execWithSessionToken(command: string, sessionToken: string, options: { cwd?: string; timeout?: number }) {
    return { command, sessionToken, options, configuration: await this.ctx.storage.get("configuration") }
  }

  async mutateAndReset() {
    const count = (await this.ctx.storage.get<number>("writes")) ?? 0
    await this.ctx.storage.put("writes", count + 1)
    await this.ctx.storage.sync()
    this.ctx.abort("test sandbox reset")
  }

  async readCount() {
    return (await this.ctx.storage.get<number>("writes")) ?? 0
  }
}

async function checkSdkConfigurationOrder(namespace: DurableObjectNamespace<ResettableSandbox>, useFresh: boolean) {
  const pipelines: Promise<unknown>[] = []
  const names: string[] = []
  let connections = 0
  // Each stub preserves E-order, but distinct stubs may arrive independently.
  // Delay configuration on its own pipeline so an extra connection overtakes it.
  const orderedNamespace = {
    idFromName(name: string) {
      names.push(name)
      return namespace.idFromName(name)
    },
    get(id: DurableObjectId) {
      connections++
      const raw = namespace.get(id)
      let pending: Promise<unknown> = Promise.resolve()
      return new Proxy(raw, {
        get(target, key) {
          if (key === "then") return undefined
          const value = Reflect.get(target, key, target)
          if (typeof value !== "function") return value
          return (...args: unknown[]) => {
            pending = pending.then(async () => {
              if (key === "configure") await new Promise((resolve) => setTimeout(resolve, 30))
              return Reflect.apply(value, raw, args)
            })
            pipelines.push(pending.catch(() => {}))
            return pending
          }
        },
      })
    },
  }
  // The real SDK is tested against just the RPC methods supplied by this fixture.
  const ns = orderedNamespace as unknown as DurableObjectNamespace<Sandbox>
  const client = (useFresh ? getSandbox : getCloudflareSandbox)(ns, useFresh ? "SDK-Fresh" : "SDK-Original", {
    normalizeId: true,
    sleepAfter: "10m",
    enableDefaultSession: false,
  })
  const exec = client.exec.bind(client)
  const nonThenable = (await Promise.resolve(client)) === client
  const connectionsBeforeCall = connections
  const result = await exec("probe", { cwd: "/review", timeout: 123 })
  await Promise.all(pipelines)
  return Response.json({ connectionsBeforeCall, connections, names, nonThenable, ...result })
}

export default {
  async fetch(request: Request, env: { Sandbox: DurableObjectNamespace<ResettableSandbox> }) {
    const mode = new URL(request.url).pathname
    if (mode === "/sdk-original" || mode === "/sdk-fresh") {
      return checkSdkConfigurationOrder(env.Sandbox, mode === "/sdk-fresh")
    }
    const connect = () => env.Sandbox.getByName(mode)
    const stub = mode === "/fresh" ? freshRpc(connect) : connect()
    // Capture before the reset, like a long-lived tool or retry callback.
    const read = stub.readCount.bind(stub)
    let rejected = false
    try {
      await stub.mutateAndReset()
    } catch {
      rejected = true
    }
    try {
      return Response.json({ rejected, count: await read(), broken: false })
    } catch {
      return Response.json({ rejected, broken: true, count: await connect().readCount() })
    }
  },
}
