import { eq, desc, and, sql, like } from "drizzle-orm";
import { Hono } from "hono";
import { webhookEvents } from "@/db/schema";
import { isAuthenticated } from "@/middlewares";
import type { AuthEnv } from "@/types";

const router = new Hono<AuthEnv>()
	.use(isAuthenticated())
	.get("/", async (c) => {
		const db = c.get("db");

		const page = Math.max(1, Number(c.req.query("page")) || 1);
		const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 25));
		const status = c.req.query("status");
		const event = c.req.query("event");
		const repo = c.req.query("repo");

		const conditions = [];
		if (status) {
			conditions.push(eq(webhookEvents.status, status));
		}
		if (event) {
			conditions.push(eq(webhookEvents.event, event));
		}
		if (repo) {
			const escaped = repo.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
			conditions.push(like(webhookEvents.repo, `%${escaped}%`));
		}

		const where = conditions.length > 0 ? and(...conditions) : undefined;
		const offset = (page - 1) * limit;

		const [events, countResult] = await Promise.all([
			db
				.select({
					id: webhookEvents.id,
					entityKey: webhookEvents.entityKey,
					event: webhookEvents.event,
					action: webhookEvents.action,
					deliveryId: webhookEvents.deliveryId,
					sender: webhookEvents.sender,
					repo: webhookEvents.repo,
					installationId: webhookEvents.installationId,
					status: webhookEvents.status,
					createdAt: webhookEvents.createdAt,
					dispatchedAt: webhookEvents.dispatchedAt,
					completedAt: webhookEvents.completedAt,
				})
				.from(webhookEvents)
				.where(where)
				.orderBy(desc(webhookEvents.createdAt))
				.limit(limit)
				.offset(offset),
			db
				.select({ count: sql<number>`count(*)` })
				.from(webhookEvents)
				.where(where),
		]);

		const total = countResult[0]?.count ?? 0;

		return c.json({
			data: events,
			pagination: {
				page,
				limit,
				total,
				totalPages: Math.ceil(total / limit),
			},
		});
	})
	.get("/stats", async (c) => {
		const db = c.get("db");

		const now = new Date();
		const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

		const [totals, recentCount] = await Promise.all([
			db
				.select({
					status: webhookEvents.status,
					count: sql<number>`count(*)`,
				})
				.from(webhookEvents)
				.groupBy(webhookEvents.status),
			db
				.select({ count: sql<number>`count(*)` })
				.from(webhookEvents)
				.where(sql`${webhookEvents.createdAt} >= ${oneDayAgo.getTime() / 1000}`),
		]);

		const byStatus: Record<string, number> = {};
		let total = 0;
		for (const row of totals) {
			byStatus[row.status] = row.count;
			total += row.count;
		}

		return c.json({
			total,
			pending: byStatus.pending ?? 0,
			dispatched: byStatus.dispatched ?? 0,
			completed: byStatus.completed ?? 0,
			failed: byStatus.failed ?? 0,
			timeout: byStatus.timeout ?? 0,
			last24h: recentCount[0]?.count ?? 0,
		});
	})
	.get("/:id", async (c) => {
		const db = c.get("db");
		const id = c.req.param("id");

		const event = await db.query.webhookEvents.findFirst({
			where: eq(webhookEvents.id, id),
		});

		if (!event) {
			return c.json({ error: "Event not found" }, 404);
		}

		return c.json(event);
	});

export default router;
