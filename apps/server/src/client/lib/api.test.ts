import { afterEach, expect, it, vi } from "vitest"
import { api } from "./api"

afterEach(() => vi.unstubAllGlobals())

it("preserves partial cleanup results from a 207 response", async () => {
  const result = { ok: false, mode: "all", deleted: 1, destroyed: 1, deletedKeys: ["done"], failed: ["retry"] }
  const fetch = vi.fn(async () => Response.json(result, { status: 207 }))
  vi.stubGlobal("fetch", fetch)
  expect(await api.clearSessions()).toEqual(result)
  expect(fetch).toHaveBeenCalledWith("/api/containers/sessions?mode=all", { method: "DELETE" })
})

it("surfaces a safe cleanup error when the server is unavailable", async () => {
  vi.stubGlobal("fetch", async () => new Response("upstream unavailable", { status: 503 }))
  await expect(api.clearSessions()).rejects.toThrow("Could not confirm cleanup")
})
