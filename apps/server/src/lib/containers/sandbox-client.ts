import { getSandbox as getCloudflareSandbox, type Sandbox, type SandboxOptions } from "@cloudflare/sandbox"
import { freshRpc } from "./fresh-rpc"

/** Keep SDK options/semantics, but never retain a poisoned RPC stub between calls. */
export function getSandbox<T extends Sandbox>(ns: DurableObjectNamespace<T>, id: string, options?: SandboxOptions) {
  return freshRpc(() => getCloudflareSandbox(ns, id, options))
}
