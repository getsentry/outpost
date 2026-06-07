// GitHub App webhook handler.
//
// Receives webhook events from GitHub, verifies the HMAC signature,
// parses the payload, extracts entity information, stores the event
// in D1, and notifies the OpenCode container.
//
// Event lifecycle:
//   1. Webhook arrives → stored in D1 as "pending"
//   2. container.fetch() notifies the container (triggers cold start if needed)
//   3. Container boots → fetches ALL pending events via config callback
//   4. Config callback marks events as "dispatched" (single source of truth)
//   5. Container processes events → marks them as "completed"
//
// This avoids race conditions where both the webhook handler and the
// config callback try to mark events as dispatched.

import { formatError } from "@jared/utils";
import { getContainer } from "@cloudflare/containers";
import { verify } from "@octokit/webhooks-methods";
import * as Sentry from "@sentry/cloudflare";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { createGitHubApp } from "@/lib/github/app";
import * as dbSchema from "@/db/schema";
import { extractEntityKey, lookupString } from "@/lib/github/entity";
import type { WebhookEvent } from "@/lib/github/types";
import type { BaseEnvBindings } from "@/types";

const router = new Hono<BaseEnvBindings>().post("/github-app", async (c) => {
	const logger = c.get("logger").child({ ns: "webhook" });
	const webhookSecret = c.env.GITHUB_APP_WEBHOOK_SECRET;
	if (!webhookSecret) {
		return c.json(
			{ error: "GitHub App webhook secret not configured" },
			503,
		);
	}

	// --- Validate required headers ---
	const event = c.req.header("x-github-event");
	const deliveryId = c.req.header("x-github-delivery");
	const signature = c.req.header("x-hub-signature-256");

	if (!event || !deliveryId) {
		return c.json(
			{
				error: "Missing required headers (x-github-event, x-github-delivery)",
			},
			400,
		);
	}

	if (!signature) {
		return c.json({ error: "Missing signature header" }, 401);
	}

	// --- Read and verify body ---
	const rawBody = await c.req.text();

	const isValid = await verify(webhookSecret, rawBody, signature);
	if (!isValid) {
		return c.json({ error: "Invalid signature" }, 401);
	}

	// --- Parse payload ---
	let payload: Record<string, unknown> = {};
	let action: string | null = null;
	try {
		payload = JSON.parse(rawBody) as Record<string, unknown>;
		if (typeof payload.action === "string") {
			action = payload.action;
		}
	} catch {
		// Non-JSON payload — proceed with empty object
	}

	// --- Extract metadata from payload ---
	const installationId =
		(payload.installation as { id?: number } | undefined)?.id ?? null;
	const sender = lookupString(payload, "sender.login");
	const repo = lookupString(payload, "repository.full_name");

	// --- Get installation Octokit for entity enrichment ---
	let entityKey = null;
	try {
		const app = createGitHubApp({
			appId: c.env.GITHUB_APP_ID,
			privateKey: c.env.GITHUB_APP_PRIVATE_KEY,
			webhookSecret,
		});

		const octokit = installationId
			? app.getInstallationOctokit(installationId)
			: null;

		entityKey = await extractEntityKey(event, payload, octokit);
	} catch (err) {
		// Entity extraction is best-effort — log and continue
		logger.warn({ error: formatError(err) }, "entity extraction failed");
		Sentry.captureException(err);
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
	};

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
	);

	// --- Store event in D1 (dedup via delivery_id UNIQUE constraint) ---
	const db = drizzle(c.env.DB, { schema: dbSchema });
	const containerKey = entityKey?.key ?? `ephemeral/${deliveryId}`;
	const eventId = crypto.randomUUID();

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
			status: "pending",
			createdAt: new Date(),
		});
	} catch (err) {
		// If delivery_id already exists, this is a duplicate — return early
		if (
			err instanceof Error &&
			err.message.includes("UNIQUE constraint failed")
		) {
			logger.info(
				{ delivery_id: deliveryId },
				"duplicate delivery, skipping",
			);
			return c.json({
				ok: true,
				delivery_id: deliveryId,
				duplicate: true,
			});
		}
		throw err;
	}

	// --- Notify the OpenCode container ---
	// The container.fetch() call triggers a cold start if the container
	// isn't running. The container's entrypoint fetches ALL pending events
	// from D1 via the config callback — we don't send event data here.
	// If the container IS already running, this acts as a notification
	// that new events are available.
	try {
		const container = getContainer(c.env.OPENCODE, containerKey);

		await container.fetch(
			new Request("http://container/notify", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					entityKey: containerKey,
					eventId,
				}),
			}),
		);

		logger.info(
			{ entity_key: containerKey, event_id: eventId },
			"container notified",
		);
	} catch (err) {
		// Container notification failure is non-fatal — events remain
		// in D1 as "pending" and will be picked up when the container
		// starts via the config callback.
		logger.error(
			{ error: formatError(err), entity_key: containerKey },
			"container notification failed",
		);
		Sentry.captureException(err);
	}

	return c.json({
		ok: true,
		delivery_id: deliveryId,
		event,
		action,
		duplicate: false,
		entity_key: entityKey?.key ?? null,
		installation_id: installationId,
	});
});

export default router;
