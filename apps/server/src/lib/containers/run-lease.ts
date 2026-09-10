type Lease = { id: string; expiresAt: number }
type Dependencies = {
  storage: {
    get(key: string): Promise<number | undefined>
    put(key: string, value: number): Promise<unknown>
    delete(key: string): Promise<unknown>
    list(options: { prefix: string }): Promise<Map<string, number>>
  }
  schedule(seconds: number, payload: Lease): Promise<unknown>
  setKeepAlive(value: boolean): Promise<void>
  now(): number
}
export class RunLeaseManager {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly deps: Dependencies
  constructor(deps: Dependencies) {
    this.deps = deps
  }
  private serial(work: () => Promise<void>) {
    const result = this.queue.then(work)
    this.queue = result.catch(() => {})
    return result
  }
  acquire(id: string) {
    return this.serial(async () => {
      // Twice Flue's one-hour submission budget. Never an indefinite lease.
      const seconds = 2 * 60 * 60
      const expiresAt = this.deps.now() + seconds * 1000
      await this.deps.schedule(seconds, { id, expiresAt })
      await this.deps.storage.put(`jared-run-cleanup:${id}`, expiresAt)
      await this.deps.storage.put(`jared-run-lease:${id}`, expiresAt)
      await this.deps.setKeepAlive(true)
    })
  }
  release(id: string) {
    return this.serial(() => this.remove(id))
  }
  private async remove(id: string) {
    await this.deps.storage.delete(`jared-run-lease:${id}`)
    const leases = await this.deps.storage.list({ prefix: "jared-run-lease:" })
    await this.deps.setKeepAlive([...leases.values()].some((expiry) => expiry > this.deps.now()))
    await this.deps.storage.delete(`jared-run-cleanup:${id}`)
  }
  expire(payload: Lease) {
    return this.serial(async () => {
      let expiry: number | undefined
      try {
        expiry = await this.deps.storage.get(`jared-run-cleanup:${payload.id}`)
      } catch (error) {
        await this.deps.schedule(60, payload)
        throw error
      }
      if (expiry !== payload.expiresAt) return
      // Container SDK consumes scheduled callbacks even when they throw. Arm a
      // successor first; successful cleanup clears the receipt and it no-ops.
      // A scheduler failure must not prevent the cleanup we can still perform.
      await this.deps.schedule(60, payload).catch(() => {})
      await this.remove(payload.id)
    })
  }
}
