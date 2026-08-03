/**
 * Phase 2 entry: re-export the Flue app route map and Cloudflare DO classes.
 * Flue's vite plugin generates/augments the Worker entry; this file remains the
 * authored composition point and preserves the prior Sentry-wrapped default.
 */

import * as Sentry from "@sentry/cloudflare"
import app, { type AppType } from "./app.ts"
import type { BaseEnvBindings } from "./types/env/base"

export type { AppType }
export { ContainerProxy } from "@cloudflare/sandbox"
export { Sandbox } from "./lib/containers/sandbox.ts"

export default Sentry.withSentry((env: BaseEnvBindings["Bindings"]) => ({ dsn: env.SENTRY_DSN }), app)
