import { describe, expect, it } from "vitest"
import { collectRepoFullNames } from "../app"

describe("collectRepoFullNames", () => {
  it("reads full_names from a raw { repositories } page envelope", () => {
    expect(collectRepoFullNames({ repositories: [{ full_name: "a/b" }, { full_name: "c/d" }] })).toEqual(["a/b", "c/d"])
  })

  it("reads full_names from a page already normalized to an array", () => {
    expect(collectRepoFullNames([{ full_name: "a/b" }, { full_name: "c/d" }])).toEqual(["a/b", "c/d"])
  })

  it("drops undefined / nameless entries instead of crashing (JARED-K)", () => {
    // The mix that used to throw `Cannot read properties of undefined (reading 'full_name')`.
    expect(collectRepoFullNames([{ full_name: "a/b" }, undefined, null, {}, { full_name: "" }])).toEqual(["a/b"])
  })

  it("is empty for missing / malformed page data", () => {
    expect(collectRepoFullNames(undefined)).toEqual([])
    expect(collectRepoFullNames(null)).toEqual([])
    expect(collectRepoFullNames({})).toEqual([])
    expect(collectRepoFullNames({ repositories: undefined })).toEqual([])
  })
})
