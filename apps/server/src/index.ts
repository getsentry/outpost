import { createLogger, formatError } from "@jared/utils";
import * as Sentry from "@sentry/cloudflare";
import { Hono } from "hono";
import { contextStorage } from "hono/context-storage";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { auth, base, rateLimit } from "./middlewares";
import router from "./routes";
import type { BaseEnvBindings } from "./types/env/base";

const app = new Hono<BaseEnvBindings>()
  .use(
    logger(),
    requestId(),
    cors({
      origin: (origin, c) => {
        const allowedOrigin = c.env.APP_URL;
        if (origin === allowedOrigin) return origin;
        if (c.env.ENV === "development") {
          try {
            const url = new URL(origin);
            if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
              return origin;
            }
          } catch {
            // Invalid origin
          }
        }
        return "";
      },
      credentials: true,
    }),
    secureHeaders(),
    contextStorage(),
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

export { ContainerProxy } from "@cloudflare/containers";
// Export the container class so Cloudflare can instantiate it as a Durable Object.
// ContainerProxy MUST be exported for outbound interception (outboundByHost) to work.
export { OpenCodeContainer } from "./containers/opencode";

export type AppType = typeof app;
export default Sentry.withSentry(
  (env: BaseEnvBindings["Bindings"]) => ({
    dsn: env.SENTRY_DSN,
  }),
  app,
);
