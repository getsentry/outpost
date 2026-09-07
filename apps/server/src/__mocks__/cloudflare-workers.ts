// Stub for `cloudflare:workers` so tests can import modules that
// transitively depend on @cloudflare/containers without needing the
// actual Cloudflare Workers runtime.

export class DurableObject {
  ctx: unknown
  env: unknown
  constructor(ctx: unknown, env: unknown) {
    this.ctx = ctx
    this.env = env
  }
}

/** Mutable module binding used by agent modules in unit tests. */
export const env: Record<string, unknown> = {}

export class WorkerEntrypoint {
  ctx: unknown
  env: unknown
  constructor(ctx: unknown, env: unknown) {
    this.ctx = ctx
    this.env = env
  }
}
