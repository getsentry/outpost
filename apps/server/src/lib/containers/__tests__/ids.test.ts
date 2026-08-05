import { describe, expect, it } from "vitest"
import { toAgentInstanceId } from "../ids"

describe("sandbox / conversation id alignment", () => {
  it("prep sandbox id equals Flue conversation id for real entity keys", () => {
    const entityKey = "getsentry/cli#1107"
    const prepId = toAgentInstanceId(entityKey)
    const conversationId = toAgentInstanceId(entityKey)
    // Jared attaches getSandbox(Sandbox, AgentProps.id) where AgentProps.id
    // is the Flue conversation id from the URL / dispatch({ id }).
    expect(prepId).toBe(conversationId)
    expect(prepId).toBe("getsentry-cli-1107")
    expect(prepId).not.toContain("/")
    expect(prepId).not.toContain("#")
  })

  it("does not leave a trailing dash after truncating long entity keys", () => {
    // 62 alnum chars + dash at index 62 → slice(0, 63) would end with "-"
    // if we did not re-strip after truncation.
    const long = `${"a".repeat(62)}-/extra-suffix#999`
    const id = toAgentInstanceId(long)
    expect(id.length).toBeLessThanOrEqual(63)
    expect(id).not.toMatch(/-$/)
    expect(id).not.toMatch(/^-/)
    expect(id).toBe("a".repeat(62))
  })
})
