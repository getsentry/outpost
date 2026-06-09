import { createLogger } from "@jared/utils"
import { drizzle } from "drizzle-orm/d1"
import type { Context, Next } from "hono"
import * as dbSchema from "@/db/schema"
import type { BaseEnv } from "@/types"
import { createAuth } from "@/utils"

export const base = () => async (c: Context<BaseEnv>, next: Next) => {
  const db = drizzle(c.env.DB, { schema: dbSchema })
  const instance = createAuth(c, db)
  const logger = createLogger({
    level: c.env.ENV === "development" ? "debug" : "info",
  })

  c.set("db", db)
  c.set("auth", instance)
  c.set("logger", logger)

  await next()
}
