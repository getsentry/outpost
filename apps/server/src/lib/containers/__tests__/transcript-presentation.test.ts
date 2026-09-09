import { describe, expect, it } from "vitest"
import { classifyInboundMessage, groupTranscriptMessages, summarizeRunActivity } from "../transcript-presentation"

const githubPrompt = `New webhook event: issue_comment.created
<!-- jared:model-tier=heavy -->

Bot identity: jared-outpost[bot]
Repository: getsentry/outpost
Entity: getsentry/outpost#42
Sender: deploy-bot[bot]
Delivery: delivery-123

## Event context

Issue #42: Improve the conversation view

Comment:
- Author: deploy-bot[bot]

Deployment finished successfully.`

describe("classifyInboundMessage", () => {
  it("makes a GitHub event readable without leaking its agent-only framing", () => {
    expect(classifyInboundMessage(githubPrompt)).toMatchObject({
      source: "github",
      label: "issue_comment.created",
      sender: "deploy-bot[bot]",
      repo: "getsentry/outpost",
      entityKey: "getsentry/outpost#42",
      subject: "Improve the conversation view",
      excerpt: "Deployment finished successfully.",
      automated: true,
    })
  })

  it("keeps operator guidance as the words the operator typed", () => {
    expect(classifyInboundMessage("Operator guidance:\n\nTry the alternate branch")).toEqual({
      source: "operator",
      text: "Try the alternate branch",
    })
  })
})

describe("groupTranscriptMessages", () => {
  it("collapses consecutive automated skipped events but leaves a human skipped event visible", () => {
    const botEvent = { info: { role: "user" }, parts: [{ type: "text", text: githubPrompt }] }
    const botSkip = { info: { role: "assistant" }, parts: [{ type: "text", text: "SKIPPED: deployment status" }] }
    const humanEvent = {
      info: { role: "user" },
      parts: [
        {
          type: "text",
          text: githubPrompt.replace("deploy-bot[bot]", "alice").replace("Deployment finished successfully.", "FYI"),
        },
      ],
    }
    const humanSkip = { info: { role: "assistant" }, parts: [{ type: "text", text: "SKIPPED: no request" }] }

    const groups = groupTranscriptMessages([botEvent, botSkip, botEvent, botSkip, humanEvent, humanSkip])

    expect(groups.map((group) => group.kind)).toEqual(["skipped-activity", "inbound", "assistant"])
    expect(groups[0]).toMatchObject({ count: 2, labels: ["issue_comment.created"] })
  })
})

describe("summarizeRunActivity", () => {
  it("uses the latest final answer rather than reasoning as the list preview", () => {
    const summary = summarizeRunActivity(
      [
        { info: { role: "user" }, parts: [{ type: "text", text: githubPrompt }] },
        {
          info: { role: "assistant" },
          parts: [
            { type: "reasoning", text: "internal detail that must not become a preview" },
            { type: "text", text: "Posted the fix and verified the focused tests." },
          ],
        },
      ],
      "idle",
    )

    expect(summary).toMatchObject({
      source: "github",
      state: "updated",
      eventLabel: "issue_comment.created",
      sender: "deploy-bot[bot]",
      summary: "Posted the fix and verified the focused tests.",
    })
  })

  it("chooses the newest assistant answer even when merged sessions arrive out of order", () => {
    const summary = summarizeRunActivity(
      [
        {
          info: { role: "assistant", createdAt: "2026-01-02T00:00:00.000Z" },
          parts: [{ type: "text", text: "Newest update" }],
        },
        {
          info: { role: "user", createdAt: "2026-01-01T00:00:00.000Z" },
          parts: [{ type: "text", text: githubPrompt }],
        },
        {
          info: { role: "assistant", createdAt: "2026-01-01T01:00:00.000Z" },
          parts: [{ type: "text", text: "Older update" }],
        },
      ],
      "idle",
    )

    expect(summary.summary).toBe("Newest update")
  })
})
