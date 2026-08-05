import { describe, expect, it } from "vitest"
import { parseOwnerRepo } from "../do-prep"

describe("parseOwnerRepo", () => {
  it("parses owner/repo#number entity keys", () => {
    expect(parseOwnerRepo("getsentry/cli#1365")).toEqual({
      owner: "getsentry",
      repo: "cli",
      slug: "getsentry/cli",
    })
  })

  it("parses PR-less owner/repo entity keys", () => {
    expect(parseOwnerRepo("getsentry/self-hosted")).toEqual({
      owner: "getsentry",
      repo: "self-hosted",
      slug: "getsentry/self-hosted",
    })
  })

  it("ignores anything after the # (issue/PR number, sub-paths)", () => {
    expect(parseOwnerRepo("getsentry/cli#1365#extra")).toEqual({
      owner: "getsentry",
      repo: "cli",
      slug: "getsentry/cli",
    })
  })

  it("returns null for malformed keys", () => {
    expect(parseOwnerRepo("")).toBeNull()
    expect(parseOwnerRepo("noslash")).toBeNull()
    expect(parseOwnerRepo("#123")).toBeNull()
    expect(parseOwnerRepo("owner/repo/extra")).toBeNull()
    expect(parseOwnerRepo("/repo")).toBeNull()
    expect(parseOwnerRepo("owner/")).toBeNull()
  })
})
