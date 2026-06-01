// Dispatch logic: routes webhook events to SandboxContainers.
// Replaces the in-memory pipeline from opentower with Container-backed
// routing that provides native session affinity via Durable Object IDs.

import { getContainer } from "@cloudflare/containers"
import { formatError, logger } from "./logger"
import type { LifecycleStore } from "./storage"
import type { Env, NormalizedTrigger } from "./types"
import type { EntityKey } from "./entity"

export type DispatchResult = {
  dispatched: boolean
  dispatch_id: string
  entity_key: string | null
  queued?: boolean
  error?: string
}

function containerName(entityKey: EntityKey): string {
  return entityKey.key.replace(/[/#]/g, "-")
}

export async function dispatchToSandbox(opts: {
  env: Env
  store: LifecycleStore
  entityKey: EntityKey
  trigger: NormalizedTrigger
  prompt: string
  deliveryId: string
  matchedEvent: string
  ghToken: string
  timeoutMs?: number
}): Promise<DispatchResult> {
  const { env, store, entityKey, trigger, prompt, deliveryId, matchedEvent, ghToken } = opts
  const timeoutMs = opts.timeoutMs ?? 1_800_000
  const dispatchId = crypto.randomUUID()
  const repoUrl = `https://github.com/${entityKey.repo}`

  await store.insertDispatch({
    id: dispatchId,
    entity_key: entityKey.key,
    session_id: null,
    trigger_name: trigger.name,
    event: matchedEvent,
    delivery_id: deliveryId,
    status: "started",
  })

  // Abort dispatch if it exceeds the timeout.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    // Resolve linked issues to find the canonical container name.
    let resolvedName = containerName(entityKey)
    if (entityKey.linkedIssues.length > 0) {
      const linkedIssueKeys = entityKey.linkedIssues.map((num) => `${entityKey.repo}#${num}`)
      const persisted = await store.resolveSession(entityKey.key, linkedIssueKeys)
      if (persisted) {
        resolvedName = persisted.entity_key.replace(/[/#]/g, "-")
      }
    }

    const container = getContainer(env.SANDBOX, resolvedName)

    const response = await container.fetch(
      new Request("https://sandbox/dispatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entity_key: entityKey.key,
          prompt,
          agent: trigger.agent,
          trigger_name: trigger.name,
          gh_token: ghToken,
          repo_url: repoUrl,
        }),
        signal: controller.signal,
      }),
    )

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Container dispatch failed (${response.status}): ${text}`)
    }

    const result = (await response.json()) as {
      ok: boolean
      session_id?: string
      share_url?: string
      queued?: boolean
    }

    if (result.session_id) {
      await store.updateDispatchSession(dispatchId, result.session_id, result.share_url ?? null)
      await store.upsertEntity({
        entity_key: entityKey.key,
        repo: entityKey.repo,
        number: entityKey.number,
        kind: entityKey.kind,
        session_id: result.session_id,
        share_url: result.share_url ?? null,
        cwd: null,
        agent: trigger.agent,
      })

      if (entityKey.kind === "pull_request" && entityKey.linkedIssues.length > 0) {
        for (const issueNum of entityKey.linkedIssues) {
          const issueKey = `${entityKey.repo}#${issueNum}`
          await store.addLink(issueKey, entityKey.key, "fixes")
        }
      }
    }

    await store.completeDispatch(dispatchId, "completed")

    logger.info("dispatch completed", {
      dispatch_id: dispatchId,
      entity_key: entityKey.key,
      trigger_name: trigger.name,
      session_id: result.session_id,
      queued: result.queued,
    })

    return {
      dispatched: true,
      dispatch_id: dispatchId,
      entity_key: entityKey.key,
      queued: result.queued,
    }
  } catch (err) {
    const status = controller.signal.aborted ? "timeout" : "failed"
    await store.completeDispatch(dispatchId, status as "timeout" | "failed")

    logger.error("dispatch failed", {
      dispatch_id: dispatchId,
      entity_key: entityKey.key,
      trigger_name: trigger.name,
      status,
      error: formatError(err),
    })

    return {
      dispatched: false,
      dispatch_id: dispatchId,
      entity_key: entityKey.key,
      error: formatError(err),
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function dispatchNoAffinity(opts: {
  env: Env
  store: LifecycleStore
  trigger: NormalizedTrigger
  prompt: string
  deliveryId: string
  matchedEvent: string
  ghToken: string
  timeoutMs?: number
}): Promise<DispatchResult> {
  const { env, store, trigger, prompt, deliveryId, matchedEvent, ghToken } = opts
  const timeoutMs = opts.timeoutMs ?? 1_800_000
  const dispatchId = crypto.randomUUID()
  const randomName = `ephemeral-${crypto.randomUUID().slice(0, 8)}`

  await store.insertDispatch({
    id: dispatchId,
    entity_key: null,
    session_id: null,
    trigger_name: trigger.name,
    event: matchedEvent,
    delivery_id: deliveryId,
    status: "started",
  })

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const container = getContainer(env.SANDBOX, randomName)

    const response = await container.fetch(
      new Request("https://sandbox/dispatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entity_key: randomName,
          prompt,
          agent: trigger.agent,
          trigger_name: trigger.name,
          gh_token: ghToken,
          repo_url: "",
        }),
        signal: controller.signal,
      }),
    )

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Container dispatch failed (${response.status}): ${text}`)
    }

    const result = (await response.json()) as { ok: boolean; session_id?: string }
    if (result.session_id) {
      await store.updateDispatchSession(dispatchId, result.session_id, null)
    }
    await store.completeDispatch(dispatchId, "completed")

    return { dispatched: true, dispatch_id: dispatchId, entity_key: null }
  } catch (err) {
    const status = controller.signal.aborted ? "timeout" : "failed"
    await store.completeDispatch(dispatchId, status as "timeout" | "failed")
    logger.error("fire-and-forget dispatch failed", {
      dispatch_id: dispatchId,
      trigger_name: trigger.name,
      status,
      error: formatError(err),
    })
    return { dispatched: false, dispatch_id: dispatchId, entity_key: null, error: formatError(err) }
  } finally {
    clearTimeout(timer)
  }
}
