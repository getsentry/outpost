import { structuredLogger } from "@hono/structured-logger";
import { createLogger, formatError } from "@jared/utils";
import * as Sentry from "@sentry/cloudflare";
import { Hono } from "hono";
import { contextStorage } from "hono/context-storage";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { auth, base, rateLimit } from "./middlewares";
import router from "./routes";
import webhooksRouter from "./routes/webhooks/github-app";
import type { BaseEnvBindings } from "./types/env/base";

const app = new Hono<BaseEnvBindings>()
  // Structured logger middleware — applies to ALL routes (including webhooks).
  // Creates a per-request logger available via c.get("logger") / c.var.logger.
  .use(
    structuredLogger({
      createLogger: (c) =>
        createLogger({
          namespace: "http",
          level: c.env.ENV === "development" ? "debug" : "info",
        }),
      onRequest: (logger, c) => {
        logger.info(
          { method: c.req.method, path: c.req.path },
          "request start",
        );
      },
      onResponse: (logger, c, elapsedMs) => {
        logger.info(
          {
            method: c.req.method,
            path: c.req.path,
            status: c.res.status,
            elapsed_ms: Math.round(elapsedMs),
          },
          "request end",
        );
      },
      onError: (logger, err, c) => {
        logger.error(
          {
            method: c.req.method,
            path: c.req.path,
            status: c.res.status,
            error: formatError(err),
          },
          "request error",
        );
      },
    }),
  )
  // Webhook routes — bypass auth and rate limiting.
  // Uses HMAC signature verification instead of better-auth.
  .route("/webhooks", webhooksRouter)
  // All other routes go through the full middleware chain
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

export type AppType = typeof app;
export default Sentry.withSentry((env: BaseEnvBindings["Bindings"]) => {
  return {
    dsn: env.SENTRY_DSN,
    // Adds request headers and IP for users, for more info visit:
    // https://docs.sentry.io/platforms/javascript/guides/cloudflare/configuration/options/#sendDefaultPii
    sendDefaultPii: true,
  };
}, app);
