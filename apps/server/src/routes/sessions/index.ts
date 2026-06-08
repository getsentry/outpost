import { eq, desc, sql } from "drizzle-orm";
import { Hono } from "hono";
import { agentSessions } from "@/db/schema";
import { isAuthenticated } from "@/middlewares";
import type { AuthEnv } from "@/types";

const router = new Hono<AuthEnv>()
	.use(isAuthenticated())
	.get("/", async (c) => {
		const db = c.get("db");

		const page = Math.max(1, Number(c.req.query("page")) || 1);
		const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 25));
		const offset = (page - 1) * limit;

		const [sessions, countResult] = await Promise.all([
			db
				.select({
					entityKey: agentSessions.entityKey,
					sessionId: agentSessions.sessionId,
					createdAt: agentSessions.createdAt,
					updatedAt: agentSessions.updatedAt,
				})
				.from(agentSessions)
				.orderBy(desc(agentSessions.updatedAt))
				.limit(limit)
				.offset(offset),
			db
				.select({ count: sql<number>`count(*)` })
				.from(agentSessions),
		]);

		const total = countResult[0]?.count ?? 0;

		return c.json({
			data: sessions,
			pagination: {
				page,
				limit,
				total,
				totalPages: Math.ceil(total / limit),
			},
		});
	})
	.get("/:entityKey", async (c) => {
		const db = c.get("db");
		const entityKey = decodeURIComponent(c.req.param("entityKey"));

		const session = await db.query.agentSessions.findFirst({
			where: eq(agentSessions.entityKey, entityKey),
		});

		if (!session) {
			return c.json({ error: "Session not found" }, 404);
		}

		return c.json(session);
	});

export default router;
