// Stub for `@cloudflare/sandbox` so tests can import modules that
// transitively depend on the Cloudflare Sandbox SDK without needing
// the actual Cloudflare Workers runtime.

export class Sandbox {}

export function getSandbox() {
  return {} as any
}

export { ContainerProxy } from "./cloudflare-workers"
