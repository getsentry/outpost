import { describe, expect, it } from "vitest"
import {
  canonicalWorkKey,
  formatExecutionContract,
  githubDiscussionWorkSourceId,
  isTerminalWorkStage,
  makeAgentWorkRecord,
} from "../work-items"

describe("agent work items", () => {
  it("keeps PR work on a PR-specific key even when its runtime session is shared with an issue", () => {
    expect(canonicalWorkKey({ repo: "getsentry/outpost", entityKey: "getsentry/outpost#17", prNumber: 42 })).toBe(
      "getsentry/outpost#pr-42",
    )
  })

  it("uses the existing entity key when there is no GitHub PR target", () => {
    expect(canonicalWorkKey({ repo: "getsentry/outpost", entityKey: "getsentry/outpost#chat-123" })).toBe(
      "getsentry/outpost#chat-123",
    )
  })

  it("reinjects unfinished work with an explicit completion rule", () => {
    const contract = formatExecutionContract([
      {
        id: "work-1",
        goal: "Fix the retry race and update the pull request.",
        stage: "implementing",
        targetPrNumber: 42,
      },
    ])

    expect(contract).toContain("Do not replace this with a status-only reply")
    expect(contract).toContain("Target pull request: #42")
  })

  it("does not treat transport progress as completed work", () => {
    expect(isTerminalWorkStage("awaiting_ci")).toBe(false)
    expect(isTerminalWorkStage("completed")).toBe(true)
    expect(isTerminalWorkStage("cancelled")).toBe(true)
  })

  it("uses one stable source identity for a GitHub discussion and its completion receipt", () => {
    expect(githubDiscussionWorkSourceId("inline", "99")).toBe("inline:99")
  })

  it("stores a bounded human goal and starts new work queued", () => {
    const record = makeAgentWorkRecord({
      id: "work-1",
      workKey: "getsentry/outpost#pr-42",
      entityKey: "getsentry/outpost#17",
      repo: "getsentry/outpost",
      sourceKind: "github",
      sourceId: "comment-99",
      goal: "x".repeat(10_000),
      targetPrNumber: 42,
      now: new Date("2026-01-02T03:04:05.000Z"),
    })

    expect(record.goal).toHaveLength(8_000)
    expect(record.stage).toBe("queued")
    expect(record.createdAt).toEqual(new Date("2026-01-02T03:04:05.000Z"))
  })
})
