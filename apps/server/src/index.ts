/**
 * Compatibility shim for tests / tooling that still import `@/index`.
 * The Cloudflare Worker entry is Flue's `virtual:flue/worker`, which imports
 * `src/app.ts` and re-exports `src/cloudflare.ts`.
 */

export { default, type AppType } from "./app.ts"
export { ContainerProxy } from "@cloudflare/sandbox"
export { Sandbox } from "./lib/containers/sandbox.ts"
