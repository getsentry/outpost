import { eq } from "drizzle-orm"
import type { Context, Next } from "hono"
import { users } from "@/db/schema"
import type { AuthEnv, AuthenticatedEnv } from "@/types"

export function auth() {
  return async (c: Context<AuthEnv>, next: Next) => {
    let session = null
    try {
      const auth = c.get("auth")
      session = await auth.api.getSession({ headers: c.req.raw.headers })
    } catch {}

    c.set("user", session?.user ?? null)
    c.set("session", session?.session ?? null)

    return await next()
  }
}

export function isAuthenticated<T extends AuthenticatedEnv>() {
  return async (c: Context<T>, next: Next) => {
    if (!c.get("user")) {
      return c.text("Unauthorized", 401)
    }

    return await next()
  }
}

export function isAdmin<T extends AuthenticatedEnv>() {
  return async (c: Context<T>, next: Next) => {
    const user = c.get("user")

    if (!user) {
      return c.text("Unauthorized", 401)
    }

    const db = c.get("db")

    const profile = await db.query.users.findFirst({
      where: eq(users.id, user.id),
      columns: {
        metadata: true,
      },
    })

    const isAdmin = profile?.metadata?.admin

    if (!isAdmin) {
      return c.text("Unauthorized - Don't have admin privileges", 401)
    }

    return await next()
  }
}
