export type RpcMethods<T> = Pick<
  T,
  {
    [K in keyof T]: T[K] extends (...args: never[]) => unknown ? K : never
  }[keyof T]
>

/**
 * A Durable Object exception can permanently break its client stub. Resolve a
 * fresh stub at method invocation, including for methods retained by adapters.
 * This forwards each call exactly once; only the caller may decide to retry.
 * Only flat RPC methods are exposed, not properties or nested session handles.
 * Connect lazily so SDK configuration and the call share the same stub's E-order.
 */
export function freshRpc<T extends object>(connect: () => T): RpcMethods<T> {
  return new Proxy({} as RpcMethods<T>, {
    get(_target, key) {
      // A Durable Object's dynamic RPC getter must not make this a thenable.
      if (key === "then") return undefined
      return (...args: unknown[]) => {
        const stub = connect()
        const method = Reflect.get(stub, key, stub)
        if (typeof method !== "function") throw new TypeError("RPC method is unavailable")
        return Reflect.apply(method, stub, args)
      }
    },
  })
}
