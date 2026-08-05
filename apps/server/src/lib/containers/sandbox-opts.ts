/**
 * Idle teardown window for every sandbox. Cloudflare stops (tears down) the
 * container this long after its last activity.
 *
 * In Phase 2 (FLUE_NATIVE=1) the container is a thin, disposable sandbox: it is
 * only active while the Durable Object brain runs `exec()` against it, so this
 * is an idle-safe teardown — it never fires mid-work (each exec resets the
 * timer) and the conversation survives in the DO regardless. A short window
 * keeps a warm container around for quick human follow-ups, then releases it.
 */
export const SANDBOX_SLEEP_AFTER = "10m" as const

/** Shared getSandbox() options for every Outpost call site. */
export const SANDBOX_OPTS = { normalizeId: true, sleepAfter: SANDBOX_SLEEP_AFTER }
