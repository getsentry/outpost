import { createLogger } from "@jared/utils";
import type { Context, Next } from "hono";
import { getContext } from "hono/context-storage";
import type { AuthEnv } from "@/types";
import { RateLimitError } from "@/utils/errors";

const logger = createLogger({ namespace: "ratelimit" });

type RateLimitOptions = {
  key?: (c: Context<AuthEnv>) => string;
  failOpen?: boolean;
};

/**
 * Get a stable identifier for rate limiting.
 * Priority: user ID > CF connecting IP > X-Forwarded-For > X-Real-IP
 * Falls back to null if no identifier can be determined.
 */
function getIdentifier(customKey?: RateLimitOptions["key"]): string | null {
  const c = getContext<AuthEnv>();
  if (customKey) return customKey(c);

  // Prefer authenticated user ID
  const userId = c.get("user")?.id;
  if (userId) return `user:${userId}`;

  // Fall back to IP-based identification
  const cfIp = c.req.header("cf-connecting-ip");
  if (cfIp) return `ip:${cfIp}`;

  const forwardedFor = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwardedFor) return `ip:${forwardedFor}`;

  const realIp = c.req.header("x-real-ip");
  if (realIp) return `ip:${realIp}`;

  return null;
}

export const rateLimit =
  ({ key, failOpen = false }: RateLimitOptions = {}) =>
  async (c: Context<AuthEnv>, next: Next) => {
    const identifier = getIdentifier(key);

    // If we can't identify the request, either fail open or closed
    if (!identifier) {
      if (failOpen) {
        logger.warn("could not identify request source, allowing request");
        return next();
      }
      throw new RateLimitError("Unable to identify request source for rate limiting");
    }

    const { success } = await c.env.RATE_LIMITER.limit({ key: identifier });

    if (!success) {
      throw new RateLimitError();
    }

    await next();
  };
