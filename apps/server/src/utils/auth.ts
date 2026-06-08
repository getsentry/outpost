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
    baseURL: c.env.BETTER_AUTH_URL,
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
        redirectURI: `${c.env.BETTER_AUTH_URL}/api/auth/callback/google`,
        // async mapProfileToUser(profile) {
        //   const email = profile.email.toLowerCase();

        //   // finding a user with the same username exists
        //   const existingUser = await db.query.users.findFirst({
        //     where: (table, { eq }) => eq(table.username, username),
        //     columns: {
        //       id: true,
        //     },
        //   });

        //   // Checking if the username is already taken
        //   if (existingUser) {
        //     // Appending the github id to the username
        //     username = `${username}-${profile.id}`;
        //   }

        //   return {
        //     username,
        //     displayUsername: profile.login,
        //   };
        // },
      },
    },
    trustedOrigins: [
      ...(c.env.ENV === "development" ? ["http://localhost:5173"] : []),
      c.env.FRONTEND_URL,
    ],
  });
}
