// GitHub App webhook handler.
//
// Receives webhook events from GitHub, verifies the HMAC signature,
// parses the payload, extracts entity information, and prepares the
// event for downstream processing by the agent.
//
// This route bypasses the standard better-auth middleware — it uses
// GitHub's X-Hub-Signature-256 HMAC verification instead.

import { formatError } from "@jared/utils";
import { verify } from "@octokit/webhooks-methods";
import * as Sentry from "@sentry/cloudflare";
import { Hono } from "hono";
import { createGitHubApp } from "@/lib/github/app";
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

	// TODO: Dispatch to agent for processing (next prompt)

	return c.json({
		ok: true,
		delivery_id: deliveryId,
		event,
		action,
		entity_key: entityKey?.key ?? null,
		installation_id: installationId,
	});
});

export default router;
