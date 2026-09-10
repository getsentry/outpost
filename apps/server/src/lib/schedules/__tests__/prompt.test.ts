import { describe, expect, it } from "vitest"
import { formatScheduledPrompt } from "../prompt"

describe("formatScheduledPrompt", () => {
  it("keeps the operator prompt authoritative and supplies only schedule metadata", () => {
    const prompt = formatScheduledPrompt({
      runId: "run-123",
      scheduleName: "Weekly security maintenance",
      repo: "sentry-internal/jared",
      intendedAt: "2026-09-14T09:00:00Z",
      text: "Review dependencies and create one PR only if fixes are needed.",
    })

    expect(prompt).toContain("Scheduled run: Weekly security maintenance")
    expect(prompt).toContain("Repository: sentry-internal/jared")
    expect(prompt).toContain("Review dependencies and create one PR only if fixes are needed.")
    expect(prompt).toContain("<!-- jared:schedule-run=run-123 -->")
    expect(prompt).not.toContain("must create a pull request")
  })
})
