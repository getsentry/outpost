import type { Logger } from "@jared/utils";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { Resend } from "resend";
import type * as dbSchema from "@/db/schema";
import type { createAuth } from "@/utils";

export type BaseEnvBindings = {
  Bindings: {
    CF_VERSION_METADATA: { id: string };
    DB: D1Database;
    RATE_LIMITER: RateLimiter;
    // The following environment variables are defined in the .dev.vars file
    // This is just for development purposes
    ENV: "development" | "production";
    BETTER_AUTH_SECRET: string;
    BETTER_AUTH_URL: string;
    GOOGLE_CLIENT_ID: string;
    GOOGLE_CLIENT_SECRET: string;
    FRONTEND_URL: string;
    REVALIDATION_SECRET: string;
    SENTRY_DSN?: string;
    RESEND_API_KEY: string;
    // GitHub App credentials for webhook handling
    GITHUB_APP_ID: string;
    GITHUB_APP_PRIVATE_KEY: string;
    GITHUB_APP_WEBHOOK_SECRET: string;
  };
  Variables: {
    logger: Logger;
  };
};

export type BaseEnv = BaseEnvBindings & {
  Variables: BaseEnvBindings["Variables"] & {
    db: DrizzleD1Database<typeof dbSchema>;
    auth: ReturnType<typeof createAuth>;
    resend: Resend;
  };
};
