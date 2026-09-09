import { describe, expect, it } from "vitest"
import { SANDBOX_OPTS } from "../sandbox-opts"

describe("SANDBOX_OPTS", () => {
  it("runs implicit sandbox operations without a persistent default shell", () => {
    // A setup script uses `set -e`; in a persistent default session, a command
    // failure terminates that shell and hides its stderr as SessionTerminatedError.
    expect(SANDBOX_OPTS.enableDefaultSession).toBe(false)
  })
})
