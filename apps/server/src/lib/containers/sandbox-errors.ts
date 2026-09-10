/** Classify infrastructure failures; callers must separately prove replay is safe. */
export function isTransientSandboxError(err: unknown): boolean {
  if (typeof err === "object" && err !== null && "code" in err && err.code === "RPC_TRANSPORT_ERROR") return true
  const msg = err instanceof Error ? err.message : String(err)
  if (msg === "Default session initialization was invalidated by a container stop") return true
  return /shell exited|session .*(?:terminat|exit)|SessionTerminated|Durable Object reset|Internal error in Durable Object|Network connection lost|HTTP error! status: 5\d\d|sandbox.*(?:not running|stopped|unavailable)/i.test(
    msg,
  )
}
