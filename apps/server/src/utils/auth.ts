import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { Context } from "hono";
import type { BaseEnv } from "@/types";

export function createAuth(
  c: Context<BaseEnv>,
  db: BaseEnv["Variables"]["db"],
) {
  return betterAuth({
    appName: "Jared",
    baseURL: c.env.APP_URL,
    basePath: "/api/auth",
    secret: c.env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, {
      provider: "sqlite",
      usePlural: true,
    }),
    user: {
      additionalFields: {
        metadata: {
          type: "json",
          input: false,
        },
      },
    },
    socialProviders: {
      google: {
        clientId: c.env.GOOGLE_CLIENT_ID,
        clientSecret: c.env.GOOGLE_CLIENT_SECRET,
        redirectURI: `${c.env.APP_URL}/api/auth/callback/google`,
      },
    },
    trustedOrigins: [
      ...(c.env.ENV === "development" ? ["http://localhost:5173"] : []),
      c.env.APP_URL,
    ],
  });
}
