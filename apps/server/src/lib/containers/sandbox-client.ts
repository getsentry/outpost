import { getSandbox as getCloudflareSandbox, type Sandbox, type SandboxOptions } from "@cloudflare/sandbox"
import { withGitHubCommandEnv } from "./command-environment"
import { freshRpc } from "./fresh-rpc"

/** Keep SDK options/semantics, but never retain a poisoned RPC stub between calls. */
export function getSandbox<T extends Sandbox>(ns: DurableObjectNamespace<T>, id: string, options?: SandboxOptions) {
  const client = freshRpc(() => getCloudflareSandbox(ns, id, options))
  if (options?.enableDefaultSession !== false) return client
  return new Proxy(client, {
    get(target, key) {
      const method = Reflect.get(target, key, target)
      if (key !== "exec" && key !== "execStream") return method
      if (typeof method !== "function") throw new TypeError("Sandbox command method is unavailable")
      return (command: string, commandOptions?: Parameters<typeof withGitHubCommandEnv>[0]) =>
        Reflect.apply(method, target, [command, withGitHubCommandEnv(commandOptions)])
    },
  })
}
