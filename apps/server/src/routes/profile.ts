import { profileSchema } from "@jared/validations";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { describeRoute, validator as sValidator } from "hono-openapi";
import { users } from "@/db/schema";
import { isAuthenticated } from "@/middlewares";
import type { AuthEnv } from "@/types";

const router = new Hono<AuthEnv>()
  .use(isAuthenticated())
  .get("/", describeRoute({ tags: ["Profile"], description: "Get current user's profile metadata" }), async (c) => {
    const currentUser = c.get("user");
    const db = c.get("db");

    const userData = await db.query.users.findFirst({
      where: eq(users.id, currentUser.id),
    });

    const profile = userData?.metadata as Record<string, unknown> | null;

    return c.json(profile);
  })
  .put(
    "/",
    describeRoute({ tags: ["Profile"], description: "Update current user's profile" }),
    sValidator("json", profileSchema),
    async (c) => {
      const currentUser = c.get("user");
      const db = c.get("db");
      const data = c.req.valid("json");

      // Get current user data
      const userData = await db.query.users.findFirst({
        where: eq(users.id, currentUser.id),
      });

      const currentMetadata = userData?.metadata;

      // Update user metadata with studentId
      await db
        .update(users)
        .set({
          metadata: {
            ...currentMetadata,
            ...data,
          },
        })
        .where(eq(users.id, currentUser.id));

      return c.json({
        success: true,
      });
    },
  );

export default router;
