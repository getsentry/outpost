import { Hono } from "hono";
import { cors } from "hono/cors";
import { openAPIRouteHandler } from "hono-openapi";
import type { AuthEnv } from "@/types";
import devRouter from "./dev";
import eventsRouter from "./events";
import profileRouter from "./profile";
import webhooksRouter from "./webhooks";

const router = new Hono<AuthEnv>()
  .get("/health", (c) => c.json({ status: "ok" }))
  .on(
    ["POST", "GET"],
    "/auth/*",
    cors({
      origin: (origin) => origin,
      allowHeaders: ["Content-Type", "Authorization"],
      allowMethods: ["POST", "GET", "OPTIONS"],
      exposeHeaders: ["Content-Length"],
      maxAge: 600,
      credentials: true,
    }),
    (c) => c.get("auth").handler(c.req.raw),
  )
  .route("/webhooks", webhooksRouter)
  .route("/events", eventsRouter)
  .route("/dev", devRouter)
  .route("/profile", profileRouter);

router.get(
  "/openapi.json",
  openAPIRouteHandler(router, {
    documentation: {
      info: {
        title: "Jared API",
        version: "1.0.0",
        description: "API for the Jared platform",
      },
      components: {
        securitySchemes: {
          cookieAuth: {
            type: "apiKey",
            in: "cookie",
            name: "better-auth.session_token",
          },
        },
      },
    },
  }),
);

export default router;
