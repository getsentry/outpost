import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it } from "vitest"
import type { SessionDetailResponse, SessionMessage } from "../lib/api"
import ContainerDetailPage from "./container-detail"

function renderRun(messages: SessionMessage[], extra: Partial<SessionDetailResponse> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const entityKey = "acme/app#42"
  client.setQueryData(["sessionDetail", entityKey], {
    entityKey,
    createdAt: "2026-09-10T00:00:00Z",
    updatedAt: "2026-09-10T00:00:00Z",
    sessions: [{ id: "session", title: "Regression fixture" }],
    sessionStatus: { session: { type: "idle" } },
    messages: { session: messages },
    status: "idle",
    ...extra,
  })
  client.setQueryData(["events", { entityKey, limit: 8 }], { data: [] })
  client.setQueryData(["agentWork", { entityKey, limit: 6 }], { data: [] })
  try {
    return renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          MemoryRouter,
          { initialEntries: ["/containers/detail?key=acme%2Fapp%2342"] },
          createElement(ContainerDetailPage),
        ),
      ),
    )
  } finally {
    client.clear()
  }
}

describe("run transcript rendering", () => {
  it("keeps tool rows between the prose that preceded and followed them", () => {
    const html = renderRun([
      {
        info: { id: "m1", role: "assistant" },
        parts: [
          { type: "text", text: "First inspect the file." },
          { type: "tool", tool: "read_fixture", state: { status: "completed", output: "found" } },
          { type: "text", text: "Then run the tests." },
          { type: "dynamic-tool", toolName: "test_fixture", state: "output-error", errorText: "Test failed" },
          { type: "text", text: "The final update." },
        ],
      },
    ])
    expect(html.indexOf("read_fixture")).toBeGreaterThan(html.indexOf("First inspect the file."))
    expect(html.indexOf("read_fixture")).toBeLessThan(html.indexOf("Then run the tests."))
    expect(html.indexOf("test_fixture")).toBeGreaterThan(html.indexOf("Then run the tests."))
    expect(html).not.toContain("Technical trace")
    expect(html).toContain('aria-expanded="false"')
  })

  it("shows incomplete cleanup and disables the composer despite an older workspace blocker", () => {
    const html = renderRun([], {
      status: "cleanup_pending",
      cleanupPending: true,
      sessionStatus: { session: { type: "blocked" } },
    } as Partial<SessionDetailResponse>)
    expect(html).toContain("Retry Destroy")
    expect(html).toMatch(/<textarea[^>]*disabled=""/)
    expect(html).toContain("Cleanup incomplete")
  })

  it("does not show an empty settled assistant as working", () => {
    const html = renderRun([{ info: { role: "assistant" }, parts: [] }], {
      status: "failed",
    } as Partial<SessionDetailResponse>)
    expect(html).not.toContain("Working…")
  })

  it("keeps reasoning in a closed disclosure at its chronological position", () => {
    const html = renderRun(
      [
        {
          info: { role: "assistant" },
          parts: [
            { type: "text", text: "Inspect first." },
            { type: "reasoning", text: "Reasoning fixture" },
            { type: "tool", tool: "inspect_fixture", state: { status: "running" } },
          ],
        },
      ],
      { status: "working" },
    )
    expect(html).toMatch(/<details[^>]*><summary[^>]*>Reasoning<\/summary>/)
    expect(html.indexOf("Reasoning fixture")).toBeLessThan(html.indexOf("inspect_fixture"))
  })
})
