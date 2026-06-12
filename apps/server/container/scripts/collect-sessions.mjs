#!/usr/bin/env node
// Collects session data from OpenCode via the SDK and outputs JSON to stdout.
// Used by the debug endpoint to get session data without version-specific curl calls.

import { createOpencodeClient } from "@opencode-ai/sdk"

const port = process.env.OPENCODE_PORT || 4096
const client = createOpencodeClient({ baseUrl: `http://localhost:${port}` })

try {
  const [sessionList, health] = await Promise.all([
    client.session.list().catch(() => ({ data: [] })),
    client.global.health().catch(() => ({ data: { healthy: false } })),
  ])

  const sessions = sessionList.data ?? []

  // Collect status (try both old and new paths)
  let sessionStatus = {}
  try {
    const res = await fetch(`http://localhost:${port}/session/status`)
    if (res.ok) sessionStatus = await res.json()
  } catch {
    try {
      const res = await fetch(`http://localhost:${port}/api/session/status`)
      if (res.ok) sessionStatus = await res.json()
    } catch { /* best effort */ }
  }

  // Collect messages for each session (limit 5 for debug)
  const messages = {}
  for (const s of sessions) {
    try {
      const msgs = await client.session.messages({
        path: { id: s.id },
        query: { limit: 5 },
      })
      messages[s.id] = msgs.data ?? []
    } catch {
      messages[s.id] = []
    }
  }

  console.log(JSON.stringify({
    healthy: health.data?.healthy ?? false,
    sessions,
    sessionStatus,
    messages,
  }))
} catch (err) {
  console.error(err.message)
  process.exit(1)
}
