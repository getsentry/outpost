import { Hono } from "hono"
import { describe, expect, it, vi } from "vitest"
import type { AuthEnv, BaseEnv } from "@/types"
import router from "../containers/workspace-recovery"

const read = vi.hoisted(() => vi.fn())
vi.mock("@/lib/containers/flue-dispatch", () => ({ readFlueHistoryInProcess: read }))

function fixture(authenticated = true) {
  const acknowledge = vi.fn(async () => true)
  const app = new Hono<AuthEnv>()
    .use(async (c, next) => {
      if (authenticated) c.set("user", { id: "operator" } as AuthEnv["Variables"]["user"])
      await next()
    })
    .route("/", router)
  const binding = { idFromName: vi.fn((id) => id), get: vi.fn(() => ({ acknowledgeWorkspaceLoss: acknowledge })) }
  read.mockResolvedValue({
    ok: true,
    history: {
      messages: [],
      settlements: [{ submissionId: "sub_one", outcome: "failed", error: { type: "workspace_lost" } }],
    },
  })
  const request = (body: unknown) =>
    app.request(
      "/getsentry%2Fcli%231568/workspace/acknowledge",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      { FLUE_JARED_AGENT: binding } as unknown as BaseEnv["Bindings"],
    )
  return { request, acknowledge, binding }
}

describe("operator workspace acknowledgement", () => {
  it("can acknowledge an exact durable blocker after Flue overrides it with abort or timeout", async () => {
    for (const receipt of [
      { submissionId: "sub_one", outcome: "aborted" },
      { submissionId: "sub_one", outcome: "failed", error: { type: "submission_timeout" } },
    ]) {
      const f = fixture()
      read.mockResolvedValue({ ok: true, history: { settlements: [receipt] } })
      expect((await f.request({ runId: "sub_one", acknowledgeDataLoss: true })).status).toBe(200)
      expect(f.acknowledge).toHaveBeenCalledWith("sub_one")
      f.acknowledge.mockResolvedValue(false)
      expect((await f.request({ runId: "sub_one", acknowledgeDataLoss: true })).status).toBe(409)
    }
  })

  it("does not add authentication to unrelated ingest and maintenance routes", async () => {
    const app = new Hono().route("/", router).post("/sessions", (c) => c.text("ingested"))
    expect((await app.request("/sessions", { method: "POST" })).status).toBe(200)
  })
  it("requires an authenticated user", async () => {
    const f = fixture(false)
    expect((await f.request({ runId: "sub_one", acknowledgeDataLoss: true })).status).toBe(401)
    expect(f.acknowledge).not.toHaveBeenCalled()
  })
  it("requires explicit data-loss acknowledgement", async () => {
    const f = fixture()
    expect((await f.request({ runId: "sub_one" })).status).toBe(400)
    expect(f.acknowledge).not.toHaveBeenCalled()
  })
  it("rejects unsettled, successful, unrelated failures and active runs", async () => {
    for (const history of [
      { settlements: [] },
      { settlements: [{ submissionId: "sub_one", outcome: "completed" }] },
      { settlements: [{ submissionId: "sub_one", outcome: "failed", error: { type: "internal_error" } }] },
      {
        messages: [{ role: "user", submissionId: "sub_open", parts: [] }],
        settlements: [{ submissionId: "sub_one", outcome: "failed", error: { type: "workspace_lost" } }],
      },
    ]) {
      const f = fixture()
      read.mockResolvedValue({ ok: true, history })
      expect((await f.request({ runId: "sub_one", acknowledgeDataLoss: true })).status).toBe(409)
      expect(f.acknowledge).not.toHaveBeenCalled()
    }
  })
  it("acknowledges only the exact failed run and never retries it", async () => {
    const f = fixture()
    const result = await f.request({ runId: "sub_one", acknowledgeDataLoss: true })
    expect(result.status).toBe(200)
    expect(await result.json()).toMatchObject({ entityKey: "getsentry/cli#1568", retried: false })
    expect(f.binding.idFromName).toHaveBeenCalledWith("getsentry-cli-1568")
    expect(f.acknowledge).toHaveBeenCalledWith("sub_one")
  })
  it("rejects an acknowledgement if another run changed the blocker", async () => {
    const f = fixture()
    f.acknowledge.mockResolvedValue(false)
    expect((await f.request({ runId: "sub_one", acknowledgeDataLoss: true })).status).toBe(409)
  })
})
