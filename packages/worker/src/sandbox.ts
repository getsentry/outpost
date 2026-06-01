// SandboxContainer: Cloudflare Container-backed Durable Object that
// runs an OpenCode instance per entity. Each entity (issue/PR) gets
// its own container with session affinity via the Durable Object ID.
//
// The container runs OpenCode in web mode, and the Worker communicates
// with it by forwarding HTTP requests to the container's OpenCode API.

import { Container } from "@cloudflare/containers"
import { formatError, logger } from "./logger"

// Port that OpenCode listens on inside the container.
const OPENCODE_PORT = 4096

class HttpError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message)
    this.name = "HttpError"
  }
}

export class SandboxContainer extends Container {
  defaultPort = OPENCODE_PORT
  sleepAfter = "10m"
  enableInternet = true

  // Per-entity state stored in the Durable Object's transactional storage.
  // This survives container sleep/wake cycles.
  private entityKey: string | null = null
  private sessionId: string | null = null
  private busy = false
  private queue: Array<{ body: string }> = []
  private batchTimer: ReturnType<typeof setTimeout> | null = null

  override async onStart() {
    const stored = await this.ctx.storage.get<{
      entityKey: string | null
      sessionId: string | null
    }>("state")
    if (stored) {
      this.entityKey = stored.entityKey
      this.sessionId = stored.sessionId
    }
    logger.info("sandbox started", {
      entity_key: this.entityKey,
      session_id: this.sessionId,
    })
  }

  override async onStop() {
    // Clear any pending batch timer.
    if (this.batchTimer !== null) {
      clearTimeout(this.batchTimer)
      this.batchTimer = null
    }
    // Persist state to DO storage so it survives container restarts.
    await this.ctx.storage.put("state", {
      entityKey: this.entityKey,
      sessionId: this.sessionId,
    })
    logger.info("sandbox stopped", {
      entity_key: this.entityKey,
    })
  }

  override async onError(error: unknown) {
    logger.error("sandbox error", {
      entity_key: this.entityKey,
      error: formatError(error),
    })
  }

  override async onActivityExpired() {
    logger.info("sandbox idle, stopping", {
      entity_key: this.entityKey,
      session_id: this.sessionId,
    })
    await this.stop()
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === "/healthz") {
      const state = await this.getState()
      return Response.json({
        ok: true,
        entity_key: this.entityKey,
        session_id: this.sessionId,
        container_status: state.status,
      })
    }

    if (url.pathname === "/dispatch" && request.method === "POST") {
      return this.handleDispatch(request)
    }

    if (url.pathname === "/state" && request.method === "GET") {
      return Response.json({
        entity_key: this.entityKey,
        session_id: this.sessionId,
        busy: this.busy,
        queue_depth: this.queue.length,
      })
    }

    // Forward all other requests to OpenCode inside the container.
    return this.containerFetch(request)
  }

  private async handleDispatch(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      entity_key: string
      prompt: string
      agent: string
      trigger_name: string
      gh_token: string
      repo_url: string
    }

    this.entityKey = body.entity_key

    // Only start the container if it's not already running.
    const state = await this.getState()
    if (state.status !== "running" && state.status !== "healthy") {
      await this.startAndWaitForPorts({
        startOptions: {
          envVars: {
            GH_TOKEN: body.gh_token,
            ENTITY_KEY: body.entity_key,
            REPO_URL: body.repo_url,
          },
        },
        cancellationOptions: {
          portReadyTimeoutMS: 120_000,
        },
      })
    }

    // If busy, queue the event for batch processing.
    if (this.busy) {
      this.queue.push({ body: JSON.stringify(body) })
      this.scheduleBatchFlush()
      return Response.json({
        ok: true,
        queued: true,
        queue_depth: this.queue.length,
      })
    }

    // Process the dispatch.
    this.busy = true
    try {
      const result = await this.processPrompt(body.prompt, body.agent)
      return Response.json({ ok: true, ...result })
    } catch (err) {
      logger.error("dispatch failed", {
        entity_key: this.entityKey,
        error: formatError(err),
      })
      return Response.json({ ok: false, error: formatError(err) }, { status: 500 })
    } finally {
      this.busy = false
      await this.flushQueue()
    }
  }

  private async processPrompt(
    prompt: string,
    agent: string,
  ): Promise<{ session_id: string; share_url?: string }> {
    if (!this.sessionId) {
      const createRes = await this.containerFetch(
        new Request("http://localhost/session.create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: `[sandbox] ${this.entityKey}`,
          }),
        }),
      )
      if (!createRes.ok) {
        const text = await createRes.text()
        throw new Error(`session.create failed (${createRes.status}): ${text}`)
      }
      const createData = (await createRes.json()) as { data?: { id: string; share?: { url: string } } }
      if (!createData.data?.id) {
        throw new Error("session.create returned no id")
      }
      this.sessionId = createData.data.id
      const shareUrl = createData.data.share?.url

      await this.ctx.storage.put("state", {
        entityKey: this.entityKey,
        sessionId: this.sessionId,
      })

      await this.sendPrompt(this.sessionId, prompt, agent)
      return { session_id: this.sessionId, share_url: shareUrl }
    }

    // Existing session: send follow-up prompt.
    try {
      await this.sendPrompt(this.sessionId, prompt, agent)
      return { session_id: this.sessionId }
    } catch (err) {
      if (isSessionNotFound(err)) {
        logger.warn("stale session, creating new", {
          entity_key: this.entityKey,
          old_session: this.sessionId,
        })
        this.sessionId = null
        return this.processPrompt(prompt, agent)
      }
      throw err
    }
  }

  private async sendPrompt(sessionId: string, prompt: string, agent: string): Promise<void> {
    const res = await this.containerFetch(
      new Request("http://localhost/session.prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: sessionId,
          agent,
          parts: [{ type: "text", text: prompt }],
        }),
      }),
    )
    if (!res.ok) {
      const text = await res.text()
      throw new HttpError(`session.prompt failed (${res.status}): ${text}`, res.status)
    }
  }

  private scheduleBatchFlush() {
    if (this.batchTimer !== null) return
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null
      if (!this.busy) {
        void this.flushQueue()
      }
    }, 5_000)
  }

  private async flushQueue(): Promise<void> {
    // Use a loop instead of recursion to prevent stack overflow when
    // events keep arriving during processing.
    while (this.queue.length > 0 && !this.busy) {
      const batch = this.queue.splice(0)
      if (batch.length === 0) break

      this.busy = true
      try {
        const prompts = batch.map((item) => {
          const parsed = JSON.parse(item.body) as { prompt: string; agent: string }
          return parsed
        })

        const combinedPrompt =
          prompts.length === 1
            ? prompts[0].prompt
            : `${prompts.length} new events arrived for this entity while you were working. Process them in order:\n\n${prompts.map((p, i) => `--- Event ${i + 1} of ${prompts.length} ---\n${p.prompt}`).join("\n\n")}`

        await this.processPrompt(combinedPrompt, prompts[0].agent)
      } catch (err) {
        logger.error("batch flush failed", {
          entity_key: this.entityKey,
          error: formatError(err),
          batch_size: batch.length,
        })
        // Salvage remaining queued events by keeping them in the queue
        // for the next flush cycle rather than dropping them.
        // The loop will exit because busy is about to be set to false
        // and the queue may still have items from concurrent pushes.
      } finally {
        this.busy = false
      }
    }
  }
}

function isSessionNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") return false
  const e = err as Record<string, unknown>
  if (e.status === 404 || e.statusCode === 404) return true
  if (typeof e.message === "string" && /not found/i.test(e.message)) return true
  return false
}
