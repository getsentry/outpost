import { Hono } from "hono"
import { readFlueHistoryInProcess } from "@/lib/containers/flue-dispatch"
import { isFlueHistoryBusy } from "@/lib/containers/flue-session-adapt"
import { toAgentInstanceId } from "@/lib/containers/ids"
import { submissionSettlementStatus } from "@/lib/events/delivery-status"
import { isAuthenticated } from "@/middlewares/auth"
import type { BaseEnv } from "@/types"

/** Acknowledge uncertainty without deleting files, history, or retrying a tool. */
export default new Hono<BaseEnv>().post("/:entityKey/workspace/acknowledge", isAuthenticated(), async (c) => {
  const body: unknown = await c.req.json().catch(() => null)
  if (
    !body ||
    typeof body !== "object" ||
    !("runId" in body) ||
    typeof body.runId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(body.runId) ||
    !("acknowledgeDataLoss" in body) ||
    body.acknowledgeDataLoss !== true
  ) {
    return c.json(
      {
        error:
          "runId and acknowledgeDataLoss: true are required. Inspect uncertain command effects and save surviving files first.",
      },
      400,
    )
  }
  const binding = c.env.FLUE_JARED_AGENT
  if (!binding) return c.json({ error: "Native agent runtime is unavailable" }, 503)
  const entityKey = c.req.param("entityKey")
  const read = await readFlueHistoryInProcess(c.env, entityKey)
  const settlements = read.ok && Array.isArray(read.history.settlements) ? read.history.settlements : []
  const receipt = settlements.find((item) => item?.submissionId === body.runId)
  // Flue can terminalize cancellation/exhausted interruption outside our guard. The
  // exact durable blocker is still required below; these receipts alone never
  // authorize clearing uncertainty.
  const interruption =
    receipt?.outcome === "aborted" ||
    (receipt?.outcome === "failed" &&
      ["submission_timeout", "submission_retry_exhausted", "submission_interrupted"].includes(
        receipt.error?.type ?? "",
      ))
  if (
    !read.ok ||
    // An interrupted tool can remain input-available after terminal settlement.
    // The exact blocker and all unsettled submissions are checked atomically by
    // acknowledgeWorkspaceLoss below; stale parts must not prevent recovery.
    isFlueHistoryBusy(read.history, { ignoreSettledParts: true }) ||
    (!interruption && submissionSettlementStatus(read.history, body.runId) !== "failed:workspace_lost")
  ) {
    return c.json({ error: "Only a settled workspace failure on an inactive run can be acknowledged" }, 409)
  }
  const stub = binding.get(binding.idFromName(toAgentInstanceId(entityKey))) as DurableObjectStub & {
    acknowledgeWorkspaceLoss(runId: string): Promise<boolean>
  }
  if (!(await stub.acknowledgeWorkspaceLoss(body.runId)))
    return c.json({ error: "The workspace blocker changed; refresh the run before acknowledging" }, 409)
  return c.json({ ok: true, entityKey, runId: body.runId, retried: false })
})
