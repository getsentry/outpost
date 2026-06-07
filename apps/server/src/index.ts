import { logger } from "hono/logger";
import { createLogger, formatError } from "@jared/utils";
import * as Sentry from "@sentry/cloudflare";
import { Hono } from "hono";
import { contextStorage } from "hono/context-storage";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { auth, base, rateLimit } from "./middlewares";
import router from "./routes";
import type { BaseEnvBindings } from "./types/env/base";

const app = new Hono<BaseEnvBindings>()
  .use(
    cors({
      origin: (origin, c) => {
        const allowedOrigin = c.env.FRONTEND_URL;
        // Allow requests from the configured frontend URL
        if (origin === allowedOrigin) return origin;
        // In development, also allow localhost variations
        if (c.env.ENV === "development" && origin?.includes("localhost")) {
          return origin;
        }
        return null;
      },
      credentials: true,
    }),
    secureHeaders(),
    contextStorage(),
    logger(),
    base(),
    auth(),
    rateLimit(),
  )
  .route("/", router)
  .onError((err, c) => {
    const logger = createLogger({
      namespace: "http",
      level: c.env.ENV === "development" ? "debug" : "info",
    });

    if (c.env.ENV === "development") {
      logger.error({ error: formatError(err) }, "unhandled error");
    } else {
      Sentry.captureException(err);
    }

    if (err instanceof HTTPException) {
      return err.getResponse();
    }

    return c.json({ error: "Internal server error" }, 500);
  });

// Export the container class so Cloudflare can instantiate it as a Durable Object.
// ContainerProxy MUST be exported for outbound interception (outboundByHost) to work.
export { OpenCodeContainer } from "./containers/opencode";
export { ContainerProxy } from "@cloudflare/containers";

export type AppType = typeof app;
export default Sentry.withSentry(
  (env: BaseEnvBindings["Bindings"]) => ({
    dsn: env.SENTRY_DSN,
  }),
  app,
);
