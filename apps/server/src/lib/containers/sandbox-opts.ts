/**
 * Idle teardown window for every sandbox. Cloudflare stops (tears down) the
 * container this long after its last activity.
 *
 * In Phase 2 (FLUE_NATIVE=1) the container is a thin, disposable sandbox. It is
 * not safe to infer inactivity from exec alone: the model may be thinking or
 * waiting on a provider. Active submissions hold a bounded keepalive lease;
 * after release, this window keeps the container warm for quick follow-ups.
 */
export const SANDBOX_SLEEP_AFTER = "10m" as const

/** Shared getSandbox() options for every Outpost call site. */
// Prep scripts use `set -e`; default sessions are persistent shells, so a failed
// command can terminate the shared shell and mask stderr as SessionTerminatedError.
// Run implicit operations sessionlessly to keep each command isolated.
export const SANDBOX_OPTS = { normalizeId: true, sleepAfter: SANDBOX_SLEEP_AFTER, enableDefaultSession: false }
