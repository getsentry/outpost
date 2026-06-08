/**
 * Cache invalidation utility for Cloudflare Workers
 */

import { createLogger, formatError } from "@jared/utils"
import { getContext } from "hono/context-storage"
import type { BaseEnv } from "@/types"

const logger = createLogger({ namespace: "cache" })

/**
 * Invalidate entries in a named cache
 * @param cacheName - The name of the cache to invalidate (e.g., 'jareds')
 * @param pattern - URL pattern to match (e.g., '/jareds')
 */
export async function invalidateCache(cacheName: string, pattern: string): Promise<void> {
  try {
    // Open the named cache used by Hono's cache middleware
    const cache = await caches.open(cacheName)

    // Note: Cloudflare Workers Cache API doesn't support listing keys or pattern-based deletion
    // We need to construct likely URLs to delete
    const baseUrl = getContext<BaseEnv>().env.BETTER_AUTH_URL
    const urlsToDelete = [
      `${baseUrl}${pattern}`,
      `${baseUrl}${pattern}?limit=1&offset=0&orderBy=-createdAt`, // TODO: Improve this logic
    ]

    await Promise.all(urlsToDelete.map((url) => cache.delete(url).catch(() => {})))
  } catch (error) {
    logger.error({ error: formatError(error), cacheName, pattern }, "cache invalidation failed")
  }
}
