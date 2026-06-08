// Formats a webhook event as a markdown prompt for the OpenCode agent.
//
// The output matches the structure expected by the jared agent:
// event type header, bot identity, repo context, and the full payload.

export function formatEventPrompt(opts: {
  event: string
  action: string | null
  deliveryId: string
  sender: string | null
  repo: string | null
  entityKey: string
  payload: string
  botLogin: string
}): string {
  const eventLabel = opts.action ? `${opts.event}.${opts.action}` : opts.event

  return `New webhook event: ${eventLabel}

Bot identity: ${opts.botLogin}
Repository: ${opts.repo ?? "unknown"}
Entity: ${opts.entityKey}
Sender: ${opts.sender ?? "unknown"}
Delivery: ${opts.deliveryId}

Payload:
\`\`\`json
${opts.payload}
\`\`\``
}
