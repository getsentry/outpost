import { readdirSync, readFileSync } from "node:fs"
import { URL } from "node:url"
import { createClient } from "@libsql/client"
import type { DrizzleD1Database } from "drizzle-orm/d1"
import { drizzle } from "drizzle-orm/libsql"
import * as schema from "@/db/schema"

/** Execute the production SQLite schema and queries, without a remote D1 binding. */
export async function testDb() {
  const client = createClient({ url: ":memory:" })
  const migrations = new URL("../../migrations/", import.meta.url)
  for (const name of readdirSync(migrations)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    await client.executeMultiple(readFileSync(new URL(name, migrations), "utf8"))
  }
  return {
    db: drizzle(client, { schema }) as unknown as DrizzleD1Database<typeof schema>,
    close: () => client.close(),
  }
}
