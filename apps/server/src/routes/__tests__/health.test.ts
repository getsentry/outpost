import { describe, expect, it } from "vitest"
import router from "../index"

describe("GET /health", () => {
  it("returns 200 with status ok", async () => {
    const res = await router.request("/health")

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: "ok" })
  })
})
