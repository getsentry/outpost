import type { AppType } from "../index.ts";
import { hc } from "hono/client";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  basePath: "/auth",
});

export const endpoint = hc<AppType>(import.meta.env.FRONTEND_URL);
