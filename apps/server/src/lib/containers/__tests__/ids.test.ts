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
})
