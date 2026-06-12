// Webhook router — mounts provider-specific handlers.
//
// Each provider (GitHub, Sentry, etc.) has its own file with
// signature verification and payload processing logic.

import { Hono } from "hono"
import type { BaseEnv } from "@/types"
import githubRouter from "./github"
import sentryRouter from "./sentry"

const router = new Hono<BaseEnv>().route("/github-app", githubRouter).route("/sentry", sentryRouter)

export default router
