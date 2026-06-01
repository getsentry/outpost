// Per-trigger filters + the evaluate-and-dispatch loop. Ported from
// opentower with dispatch adapted for the Worker->Container architecture.

import type { EntityKey } from "./entity"
import { extractEntityKey } from "./entity"
import type { GitHubFetcher } from "./github-api"
import { logger } from "./logger"
import { renderTemplate } from "./template"
import type { NormalizedTrigger, SkippedDispatch } from "./types"

function eventMatches(pattern: string, event: string, action: string | null): boolean {
  if (pattern === "*") return true

  const colon = pattern.indexOf(":")
  if (colon !== -1) {
    const evPart = pattern.slice(0, colon)
    const actPart = pattern.slice(colon + 1)
    return evPart === event && actPart === action
  }

  if (pattern === event) return true
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -1)
    return event.startsWith(prefix)
  }
  return false
}

export function findMatching(triggers: NormalizedTrigger[], event: string, action: string | null): NormalizedTrigger[] {
  return triggers.filter((t) => {
    if (t.enabled === false) return false
    const eventOk = t.events.some((e) => eventMatches(e, event, action))
    if (!eventOk) return false
    return t.action === null || t.action === action
  })
}

export function evaluateIgnoreAuthors(ignoreAuthors: string[] | undefined, sender: string | null): string | null {
  if (!ignoreAuthors || ignoreAuthors.length === 0 || !sender) return null
  const lower = sender.toLowerCase()
  if (ignoreAuthors.some((a) => a.toLowerCase() === lower)) {
    return `ignored sender '${sender}'`
  }
  return null
}

export type DispatchTarget = {
  entityKey: EntityKey | null
  trigger: NormalizedTrigger
  prompt: string
  deliveryId: string
  matchedEvent: string
}

export async function evaluateAndExtract(opts: {
  triggers: NormalizedTrigger[]
  event: string
  action: string | null
  payload: unknown
  sender: string | null
  botLogin: string | null
  deliveryId: string
  templateContext: Record<string, unknown>
  githubFetcher?: GitHubFetcher | null
}): Promise<{ targets: DispatchTarget[]; skipped: SkippedDispatch[] }> {
  const targets: DispatchTarget[] = []
  const skipped: SkippedDispatch[] = []

  const entityKey = await extractEntityKey(opts.event, opts.payload, opts.githubFetcher)

  const matched = findMatching(opts.triggers, opts.event, opts.action)
  if (matched.length === 0) {
    logger.warn("no matching triggers", {
      event: opts.event,
      action: opts.action,
      delivery_id: opts.deliveryId,
      trigger_count: opts.triggers.length,
    })
  }

  for (const t of matched) {
    const reason = evaluateIgnoreAuthors(t.ignore_authors, opts.sender)
    if (reason) {
      skipped.push({ name: t.name, reason })
      logger.info("trigger skipped", {
        trigger_name: t.name,
        event: opts.event,
        reason,
        delivery_id: opts.deliveryId,
      })
      continue
    }

    const prompt = renderTemplate(t.prompt_template, opts.templateContext)
    targets.push({
      entityKey,
      trigger: t,
      prompt,
      deliveryId: opts.deliveryId,
      matchedEvent: opts.event,
    })
  }

  return { targets, skipped }
}
