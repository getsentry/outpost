#!/usr/bin/env node
// Keepalive script — periodically collects session data from OpenCode
// and POSTs it to the Worker for persistence in D1.
//
// Uses the OpenCode SDK for type-safe, version-resilient API access.
// Runs inside the container as a background process.

import { createOpencodeClient } from "@opencode-ai/sdk"

const OPENCODE_URL = `http://localhost:${process.env.OPENCODE_PORT || 4096}`
const ENTITY_KEY = process.env.ENTITY_KEY || ""
const WORKER_URL = "http://jared.internal"
const INTERVAL_MS = 45_000
const INITIAL_DELAY_MS = 10_000
const MAX_RUNTIME_MS = 2 * 60 * 60 * 1000 // 2 hours
const MESSAGE_LIMIT = 50

const started = Date.now()

const client = createOpencodeClient({
  baseUrl: OPENCODE_URL,
})

async function collectAndPost() {
  try {
    // Health check
    const health = await client.global.health()
    if (!health.data?.healthy) {
      console.warn("[keepalive] OpenCode not healthy, stopping")
      process.exit(0)
    }

    // Collect session data
    const sessionList = await client.session.list()
    const sessions = sessionList.data ?? []

    // Collect status — try/catch since this endpoint may vary by version
    let sessionStatus = {}
    try {
      const statusRes = await fetch(`${OPENCODE_URL}/session/status`)
      if (statusRes.ok) sessionStatus = await statusRes.json()
    } catch {
      // v1.17.4+ may not have this endpoint at the same path
      try {
        const statusRes = await fetch(`${OPENCODE_URL}/api/session/status`)
        if (statusRes.ok) sessionStatus = await statusRes.json()
      } catch { /* best effort */ }
    }

    // Collect messages for each session
    const messages = {}
    for (const session of sessions) {
      try {
        const msgRes = await client.session.messages({
          path: { id: session.id },
          query: { limit: MESSAGE_LIMIT },
        })
        messages[session.id] = msgRes.data ?? []
      } catch {
        messages[session.id] = []
      }
    }

    // Collect logs
    let logs = ""
    try {
      const logProc = await import("node:child_process")
      logs = logProc.execSync("tail -100 /tmp/opencode.log 2>/dev/null", {
        encoding: "utf-8",
        timeout: 5000,
      })
    } catch { /* best effort */ }

    // Build payload
    const payload = {
      entityKey: ENTITY_KEY,
      sessionData: JSON.stringify({
        sessionStatus,
        sessions,
        logs,
        messages,
      }),
    }

    // POST to Worker via outbound interception
    const res = await fetch(`${WORKER_URL}/sessions/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })

    if (res.ok) {
      console.log(`[keepalive] saved: ${sessions.length} sessions, ${Object.values(messages).flat().length} messages`)
    } else {
      console.warn(`[keepalive] save failed: ${res.status}`)
    }
  } catch (err) {
    console.warn(`[keepalive] error: ${err.message}`)
  }
}

// Main loop
async function main() {
  if (!ENTITY_KEY) {
    console.error("[keepalive] ENTITY_KEY not set, exiting")
    process.exit(1)
  }

  console.log(`[keepalive] starting for ${ENTITY_KEY}, initial delay ${INITIAL_DELAY_MS}ms`)
  await new Promise((r) => setTimeout(r, INITIAL_DELAY_MS))

  while (true) {
    await collectAndPost()

    // Check max runtime
    if (Date.now() - started >= MAX_RUNTIME_MS) {
      console.log("[keepalive] max runtime reached, exiting")
      break
    }

    await new Promise((r) => setTimeout(r, INTERVAL_MS))
  }
}

main().catch((err) => {
  console.error("[keepalive] fatal:", err)
  process.exit(1)
})
