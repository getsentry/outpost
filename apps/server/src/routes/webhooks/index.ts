// GitHub App webhook handler.
//
// Receives webhook events from GitHub, verifies the HMAC signature,
// parses the payload, extracts entity information, stores the event
// in D1, and dispatches it to the OpenCode sandbox.
//
// Event lifecycle:
//   1. Webhook arrives → stored in D1
//      - Entity found → status "pending"
//      - No entity    → status "skipped" (no container created)
//   2. Return 200 to GitHub immediately
//   3. In waitUntil(): dispatch to OpenCode sandbox
//      - Get or create sandbox for entity
//      - Clone repo, configure git, start opencode serve
//      - Find or create OpenCode session
//      - Send prompt via prompt_async
//      - Mark event as "dispatched"
//      - On failure → mark event as "failed"

import { getSandbox } from "@cloudflare/sandbox"
import { formatError } from "@jared/utils"
import { verify } from "@octokit/webhooks-methods"
import * as Sentry from "@sentry/cloudflare"
import { eq } from "drizzle-orm"
import { Hono } from "hono"
import * as dbSchema from "@/db/schema"
import { createGitHubApp } from "@/lib/github/app"
import { TRIGGER_LABEL } from "@/lib/github/constants"
import { extractEntityKey, lookupString } from "@/lib/github/entity"
import { formatEventPrompt } from "@/lib/github/prompt"
import type { WebhookEvent } from "@/lib/github/types"
import type { BaseEnv } from "@/types"

const OPENCODE_PORT = 4096

const router = new Hono<BaseEnv>().post("/github-app", async (c) => {
  const logger = c.get("logger").child({ ns: "webhook" })
  const db = c.get("db")
  const webhookSecret = c.env.GITHUB_APP_WEBHOOK_SECRET
  if (!webhookSecret) {
    return c.json({ error: "GitHub App webhook secret not configured" }, 503)
  }

  // --- Validate required headers ---
  const event = c.req.header("x-github-event")
  const deliveryId = c.req.header("x-github-delivery")
  const signature = c.req.header("x-hub-signature-256")

  if (!event || !deliveryId) {
    return c.json(
      {
        error: "Missing required headers (x-github-event, x-github-delivery)",
      },
      400,
    )
  }

  if (!signature) {
    return c.json({ error: "Missing signature header" }, 401)
  }

  // --- Read and verify body ---
  const rawBody = await c.req.text()

  const isValid = await verify(webhookSecret, rawBody, signature)
  if (!isValid) {
    return c.json({ error: "Invalid signature" }, 401)
  }

  // --- Parse payload ---
  let payload: Record<string, unknown> = {}
  let action: string | null = null
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>
    if (typeof payload.action === "string") {
      action = payload.action
    }
  } catch {
    // Non-JSON payload — proceed with empty object
  }

  // --- Extract metadata from payload ---
  const installationId = (payload.installation as { id?: number } | undefined)?.id ?? null
  const sender = lookupString(payload, "sender.login")
  const repo = lookupString(payload, "repository.full_name")

  // --- Get installation Octokit for entity enrichment ---
  let entityKey = null
  let botLogin = ""
  const app = createGitHubApp({
    appId: c.env.GITHUB_APP_ID,
    privateKey: c.env.GITHUB_APP_PRIVATE_KEY,
    webhookSecret,
  })

  try {
    const octokit = installationId ? app.getInstallationOctokit(installationId) : null

    entityKey = await extractEntityKey(event, payload, octokit)
  } catch (err) {
    // Entity extraction is best-effort — log and continue
    logger.warn({ error: formatError(err) }, "entity extraction failed")
    Sentry.captureException(err)
  }

  try {
    botLogin = await app.getBotLogin()
  } catch (err) {
    logger.warn({ error: formatError(err) }, "bot login resolution failed")
  }

  // --- Build structured event ---
  const webhookEvent: WebhookEvent = {
    event,
    action,
    deliveryId,
    installationId,
    sender,
    repo,
    entityKey,
    payload,
  }

  // --- Log the event ---
  logger.info(
    {
      event: webhookEvent.event,
      action: webhookEvent.action,
      delivery_id: webhookEvent.deliveryId,
      sender: webhookEvent.sender,
      repo: webhookEvent.repo,
      entity_key: webhookEvent.entityKey?.key ?? null,
      installation_id: webhookEvent.installationId,
    },
    "webhook.received",
  )

  // --- Determine if this event is routable to a container ---
  // Skip issues.labeled events unless the label matches the trigger label,
  // to avoid spinning up containers for irrelevant label additions.
  // Also skip issues.assigned/unassigned — assignment is not used as a trigger
  // (GitHub App bots can't be assigned via the UI).
  const isSkipped =
    !entityKey ||
    (event === "issues" && action === "labeled" && lookupString(payload, "label.name") !== TRIGGER_LABEL) ||
    (event === "issues" && (action === "assigned" || action === "unassigned"))
  const containerKey = entityKey?.key ?? `ephemeral/${deliveryId}`
  const eventId = crypto.randomUUID()

  // --- Store event in D1 (dedup via delivery_id UNIQUE constraint) ---
  try {
    await db.insert(dbSchema.webhookEvents).values({
      id: eventId,
      entityKey: containerKey,
      event,
      action,
      deliveryId,
      sender,
      repo,
      installationId,
      payload: rawBody,
      status: isSkipped ? "skipped" : "pending",
      createdAt: new Date(),
    })
  } catch (err) {
    // If delivery_id already exists, this is a duplicate — return early
    if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
      logger.info({ delivery_id: deliveryId }, "duplicate delivery, skipping")
      return c.json({
        ok: true,
        delivery_id: deliveryId,
        duplicate: true,
      })
    }
    throw err
  }

  // --- If skipped (no entity or filtered out), we're done ---
  if (isSkipped) {
    logger.info({ delivery_id: deliveryId, event, action }, "event skipped")
    return c.json({
      ok: true,
      delivery_id: deliveryId,
      event,
      action,
      duplicate: false,
      entity_key: entityKey?.key ?? null,
      installation_id: installationId,
      skipped: true,
    })
  }

  // --- Dispatch to sandbox in the background ---
  // Return 200 to GitHub immediately, then handle sandbox communication
  // asynchronously via waitUntil().

  /** Mark an event as failed in D1 so it doesn't stay stuck in "pending". */
  async function markEventFailed(reason: string) {
    try {
      await db.update(dbSchema.webhookEvents).set({ status: "failed" }).where(eq(dbSchema.webhookEvents.id, eventId))
    } catch (dbErr) {
      logger.error({ error: formatError(dbErr), event_id: eventId }, "failed to mark event as failed")
    }
    logger.error({ entity_key: containerKey, event_id: eventId, reason }, "dispatch failed")
  }

  // Mint a GitHub installation token for the sandbox
  let installationToken = ""
  if (installationId) {
    try {
      const octokit = app.getInstallationOctokit(installationId)
      const auth = (await octokit.auth({ type: "installation" })) as { token: string }
      installationToken = auth.token
    } catch (err) {
      logger.warn({ error: formatError(err) }, "failed to mint installation token")
    }
  }

  c.executionCtx.waitUntil(
    (async () => {
      try {
        const sandbox = getSandbox(c.env.Sandbox, containerKey, { normalizeId: true })

        // Check if OpenCode is already running
        let opencodeReady = false
        try {
          const checkResult = await sandbox.exec(`curl -sf http://localhost:${OPENCODE_PORT}/global/health`, {
            cwd: "/workspace",
          })
          opencodeReady = checkResult.success
        } catch {
          // Not running yet
        }

        if (!opencodeReady) {
          // --- First time setup: clone repo, configure git, start opencode ---

          if (repo) {
            // Clone repo if not already cloned
            const checkRepo = await sandbox.exec("test -d /workspace/repo/.git", { cwd: "/workspace" })
            if (!checkRepo.success) {
              const cloneUrl = installationToken
                ? `https://x-access-token:${installationToken}@github.com/${repo}.git`
                : `https://github.com/${repo}.git`
              const cloneResult = await sandbox.exec(`git clone --depth 50 ${cloneUrl} /workspace/repo`, {
                cwd: "/workspace",
              })
              if (!cloneResult.success) {
                await markEventFailed(`git clone failed: ${cloneResult.stderr}`)
                return
              }
            }

            // Configure git identity
            if (botLogin) {
              const botEmail = `${botLogin}@users.noreply.github.com`
              await sandbox.exec(`git config user.name "${botLogin}" && git config user.email "${botEmail}"`, {
                cwd: "/workspace/repo",
              })
            }

            // Authenticate gh CLI
            if (installationToken) {
              await sandbox.exec(`echo "${installationToken}" | gh auth login --with-token`, {
                cwd: "/workspace/repo",
              })
            }
          }

          // Write env vars to a file and start OpenCode with them
          const envLines: string[] = []
          if (installationToken) envLines.push(`export GH_TOKEN="${installationToken}"`)
          if (c.env.ANTHROPIC_API_KEY) envLines.push(`export ANTHROPIC_API_KEY="${c.env.ANTHROPIC_API_KEY}"`)
          if (c.env.OPENAI_API_KEY) envLines.push(`export OPENAI_API_KEY="${c.env.OPENAI_API_KEY}"`)
          if (c.env.SENTRY_DSN) envLines.push(`export SENTRY_DSN="${c.env.SENTRY_DSN}"`)

          if (envLines.length > 0) {
            await sandbox.exec(`printf '%s\\n' ${envLines.map((l) => `'${l}'`).join(" ")} > /tmp/opencode-env.sh`, {
              cwd: "/workspace",
            })
          }

          // Start OpenCode serve (source env file if it exists)
          const startCmd = `bash -c '[ -f /tmp/opencode-env.sh ] && . /tmp/opencode-env.sh; exec opencode serve --port ${OPENCODE_PORT} --hostname 0.0.0.0'`
          const opencodeProcess = await sandbox.startProcess(startCmd, {
            cwd: repo ? "/workspace/repo" : "/workspace",
            onError(error) {
              logger.error({ error: String(error), entity_key: containerKey }, "opencode process error")
            },
            onExit(code) {
              logger.info({ exit_code: code, entity_key: containerKey }, "opencode process exited")
            },
          })

          // Wait for OpenCode to be ready
          await opencodeProcess.waitForPort(OPENCODE_PORT)
        }

        // --- OpenCode is running — dispatch the event ---
        const OC = `http://localhost:${OPENCODE_PORT}`

        // Find or create an OpenCode session
        const listResult = await sandbox.exec(`curl -sf ${OC}/session`, { cwd: "/workspace" })
        let sessionId: string | null = null

        if (listResult.success && listResult.stdout) {
          try {
            const sessions = JSON.parse(listResult.stdout) as Array<{ id: string }>
            if (sessions.length > 0) {
              sessionId = sessions[0].id
            }
          } catch {
            // parse error
          }
        }

        if (!sessionId) {
          const createResult = await sandbox.exec(
            `curl -sf -X POST -H 'Content-Type: application/json' -d '${JSON.stringify({ title: containerKey }).replace(/'/g, "'\\''")}' ${OC}/session`,
            { cwd: "/workspace" },
          )
          if (createResult.success && createResult.stdout) {
            try {
              const session = JSON.parse(createResult.stdout) as { id: string }
              sessionId = session.id
            } catch {
              // parse error
            }
          }
        }

        if (!sessionId) {
          await markEventFailed("failed to find or create session")
          return
        }

        // Format the event as a markdown prompt
        const prompt = formatEventPrompt({
          event,
          action,
          deliveryId,
          sender,
          repo,
          entityKey: containerKey,
          payload: rawBody,
          botLogin,
        })

        // Write the prompt to a temp file to avoid shell escaping issues
        const promptPayload = JSON.stringify({ parts: [{ type: "text", text: prompt }] })
        const promptFile = `/tmp/prompt-${eventId}.json`
        await sandbox.exec(`cat > ${promptFile} << 'PROMPT_EOF'\n${promptPayload}\nPROMPT_EOF`, { cwd: "/workspace" })

        // Send the prompt asynchronously — OpenCode queues it if busy
        const promptResult = await sandbox.exec(
          `curl -sf -X POST -H 'Content-Type: application/json' -d @${promptFile} ${OC}/session/${sessionId}/prompt_async`,
          { cwd: "/workspace" },
        )

        // Clean up temp file
        await sandbox.exec(`rm -f ${promptFile}`, { cwd: "/workspace" })

        if (!promptResult.success) {
          await markEventFailed(`prompt_async failed: ${promptResult.stderr}`)
          return
        }

        // Mark the event as dispatched
        await db
          .update(dbSchema.webhookEvents)
          .set({ status: "dispatched", dispatchedAt: new Date() })
          .where(eq(dbSchema.webhookEvents.id, eventId))

        logger.info(
          {
            entity_key: containerKey,
            event_id: eventId,
            session_id: sessionId,
          },
          "event dispatched to agent",
        )
      } catch (err) {
        await markEventFailed(formatError(err))
        Sentry.captureException(err)
      }
    })(),
  )

  return c.json({
    ok: true,
    delivery_id: deliveryId,
    event,
    action,
    duplicate: false,
    entity_key: entityKey?.key ?? null,
    installation_id: installationId,
    skipped: false,
  })
})

export default router
