import { drizzle } from "drizzle-orm/d1"
import type { Context, Next } from "hono"
import * as dbSchema from "@/db/schema"
import type { BaseEnv } from "@/types"
import { createAuth } from "@/utils"

export const base = () => async (c: Context<BaseEnv>, next: Next) => {
  const db = drizzle(c.env.DB, { schema: dbSchema })
  const instance = createAuth(c, db)

  // Adding the variables to the context
  c.set("db", db)
  c.set("auth", instance)

  await next()
}
