import { describe, expect, it } from "vitest"
import { formatChatPrompt } from "@/lib/github/prompt"
import {
  chatEntityRepo,
  createChatEntityKey,
  formatOperatorPrompt,
  isChatEntityKey,
  isValidRepoSlug,
  MAX_CHAT_REPO_LENGTH,
  operatorText,
} from "../chat-run"
import { parseOwnerRepo } from "../do-prep"
import { toAgentInstanceId } from "../ids"

describe("chat run entity keys", () => {
  it("keeps the repo resolvable so the sandbox can clone it", () => {
    const key = createChatEntityKey("getsentry/outpost")
    expect(parseOwnerRepo(key)).toEqual({ owner: "getsentry", repo: "outpost", slug: "getsentry/outpost" })
  })

  it("mints a distinct key per run and recognizes it as a chat run", () => {
    const a = createChatEntityKey("getsentry/outpost")
    const b = createChatEntityKey("getsentry/outpost")

    expect(a).not.toBe(b)
    expect(isChatEntityKey(a)).toBe(true)
    expect(chatEntityRepo(a)).toBe("getsentry/outpost")
  })

  it("does not mistake webhook entity keys for chat runs", () => {
    expect(isChatEntityKey("getsentry/outpost#1107")).toBe(false)
    expect(chatEntityRepo("getsentry/outpost#1107")).toBeNull()
    expect(chatEntityRepo("getsentry/outpost")).toBeNull()
  })

  it("survives sandbox id sanitization, so two runs never share a container", () => {
    const repo = `${"a".repeat(20)}/${"b".repeat(MAX_CHAT_REPO_LENGTH - 21)}`
    const a = toAgentInstanceId(createChatEntityKey(repo))
    const b = toAgentInstanceId(createChatEntityKey(repo))

    expect(a).not.toBe(b)
    expect(a.length).toBeLessThanOrEqual(63)
  })

  it("rejects repos that are not owner/name, or long enough to be truncated", () => {
    expect(isValidRepoSlug("getsentry/outpost")).toBe(true)
    expect(isValidRepoSlug("getsentry/out.post-1_x")).toBe(true)
    expect(isValidRepoSlug("outpost")).toBe(false)
    expect(isValidRepoSlug("getsentry/outpost/extra")).toBe(false)
    expect(isValidRepoSlug("getsentry/out post")).toBe(false)
    expect(isValidRepoSlug("-bad/repo")).toBe(false)
    expect(isValidRepoSlug(`${"a".repeat(40)}/${"b".repeat(40)}`)).toBe(false)
  })
})

describe("operatorText", () => {
  it("recovers what the operator typed from a chat run's opening prompt", () => {
    const prompt = formatChatPrompt({
      entityKey: "getsentry/outpost#chat-abc12345",
      repo: "getsentry/outpost",
      botLogin: "jared-outpost[bot]",
      operator: "alice",
      text: "look into the flaky retention test",
    })

    expect(prompt).toContain("Bot identity: jared-outpost[bot]")
    expect(prompt).toContain("Operator: alice")
    expect(operatorText(prompt)).toBe("look into the flaky retention test")
  })

  it("strips the guidance prefix from mid-run operator turns", () => {
    expect(operatorText(formatOperatorPrompt("try the other branch"))).toBe("try the other branch")
  })

  it("leaves webhook prompts alone, even when a payload mimics the marker", () => {
    const prompt = "New webhook event: issues.labeled\n\n## Event context\n\nIssue body:\n## Request\n\nplease help"
    expect(operatorText(prompt)).toBe(prompt)
  })
})
