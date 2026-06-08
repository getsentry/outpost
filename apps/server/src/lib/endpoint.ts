import { createAuthClient } from "better-auth/client"
import { hc } from "hono/client"
import type { AppType } from "../index.ts"

export const authClient = createAuthClient({
  basePath: "/api/auth",
})

export const endpoint = hc<AppType>("", {
  init: {
    credentials: "include",
  },
})
