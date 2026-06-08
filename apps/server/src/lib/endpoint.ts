import type { AppType } from "../index.ts";
import { hc } from "hono/client";
import { createAuthClient } from "better-auth/client";

export const authClient = createAuthClient({
  basePath: "/auth",
});

export const endpoint = hc<AppType>("", {
  init: {
    credentials: "include",
  },
});
