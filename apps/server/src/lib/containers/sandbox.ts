// Re-export Sandbox from @cloudflare/sandbox.
// Previously this file contained JaredSandbox with outbound interception
// via jared.internal, but that never worked reliably. Session data is now
// synced via the debug endpoint and auto-sync on detail page access.

export { Sandbox } from "@cloudflare/sandbox"
