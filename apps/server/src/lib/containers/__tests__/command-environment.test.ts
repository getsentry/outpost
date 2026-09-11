import type { Sandbox } from "@cloudflare/sandbox"
import { describe, expect, it, vi } from "vitest"
import { GITHUB_COMMAND_ENV, withGitHubCommandEnv } from "../command-environment"
import { getSandbox } from "../sandbox-client"

const mocks = vi.hoisted(() => ({ getSandbox: vi.fn() }))
vi.mock("@cloudflare/sandbox", () => ({ getSandbox: mocks.getSandbox }))

describe("sessionless command environment", () => {
  it.each(["exec", "execStream"] as const)("adds bootstrap options lazily to %s", async (method) => {
    const call = vi.fn(async () => "ok")
    mocks.getSandbox.mockReset().mockReturnValue({ [method]: call })
    const client = getSandbox({} as DurableObjectNamespace, "test", { enableDefaultSession: false })
    const options = {
      cwd: "/repo",
      timeout: 123,
      env: { TEST: "value" },
      onOutput: vi.fn(),
      signal: new AbortController().signal,
    }
    const retained = client[method].bind(client)
    expect(mocks.getSandbox).not.toHaveBeenCalled()
    await retained("probe", options)
    expect(call).toHaveBeenCalledExactlyOnceWith("probe", {
      ...options,
      env: { BASH_ENV: GITHUB_COMMAND_ENV, TEST: "value" },
    })
    expect(options.env).toEqual({ TEST: "value" })
  })

  it.each([
    { env: { GH_TOKEN: "explicit" } },
    { env: { GH_TOKEN: undefined } },
    { env: { BASH_ENV: "/custom.sh" } },
    { env: { BASH_ENV: undefined } },
    { sessionId: "explicit-session", env: { TEST: "value" } },
  ])("preserves explicit credentials, startup hooks, and sessions: %j", (options) => {
    expect(withGitHubCommandEnv(options)).toEqual(options)
  })

  it("does not modify default-session clients", async () => {
    const exec = vi.fn(async () => "ok")
    mocks.getSandbox.mockReset().mockReturnValue({ exec })
    const client = getSandbox<Sandbox>({} as DurableObjectNamespace<Sandbox>, "test")
    await client.exec("probe")
    expect(exec).toHaveBeenCalledExactlyOnceWith("probe")
  })
})
