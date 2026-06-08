import { HTTPException } from "hono/http-exception"

export class RateLimitError extends HTTPException {
  constructor(message = "Too many requests") {
    super(429, {
      message,
    })
  }
}
