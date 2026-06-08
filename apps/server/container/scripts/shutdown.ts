#!/usr/bin/env bun
// Container shutdown script — runs before the container stops.
//
// Exports the active OpenCode session and saves it to D1 via the
// Worker's outbound interceptor so it can be restored on next start.

import { $ } from "bun"

const WORKER_URL = "http://worker.internal"
const ENTITY_KEY = process.env.ENTITY_KEY ?? ""

async function main() {
  console.log("[shutdown] Exporting session...")

  // Get the most recent session ID
  const listResult = await $`opencode session list --format json`.nothrow().quiet()
  if (listResult.exitCode !== 0) {
    console.error("[shutdown] Could not list sessions")
    return
  }

  let sessions: Array<{ id: string }>
  try {
    sessions = JSON.parse(listResult.stdout.toString())
  } catch {
    console.error("[shutdown] Could not parse session list")
    return
  }

  if (sessions.length === 0) {
    console.log("[shutdown] No sessions to export")
    return
  }

  const sessionId = sessions[0].id
  console.log(`[shutdown] Exporting session ${sessionId}...`)

  // Export the session as JSON
  const exportResult = await $`opencode export ${sessionId}`.nothrow().quiet()
  if (exportResult.exitCode !== 0) {
    console.error("[shutdown] Session export failed")
    return
  }

  const sessionData = exportResult.stdout.toString()

  // Save to D1 via the Worker
  try {
    const response = await fetch(`${WORKER_URL}/sessions/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entityKey: ENTITY_KEY,
        sessionId,
        sessionData,
      }),
    })

    if (response.ok) {
      console.log("[shutdown] Session saved to D1")
    } else {
      console.error(`[shutdown] Save failed: ${response.status} ${await response.text()}`)
    }
  } catch (err) {
    console.error("[shutdown] Could not reach worker:", err)
  }
}

await main()
