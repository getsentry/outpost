import { Hono } from "hono"
import type { AuthEnv } from "@/types"
import authDevRouter from "./auth"

const router = new Hono<AuthEnv>()
  .use(async (c, next) => {
    if (c.env.ENV !== "development") {
      return c.text("Not Found", 404)
    }

    await next()
  })
  .route("/auth", authDevRouter)

export default router
