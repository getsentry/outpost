import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { expect, it } from "vitest"
import { ClearSessionsFeedback } from "./clear-sessions-feedback"

it("shows partial counts and links only failed runs for deliberate per-run retry", () => {
  const html = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      {},
      createElement(ClearSessionsFeedback, {
        error: null,
        result: {
          ok: false,
          mode: "all",
          deleted: 2,
          destroyed: 2,
          deletedKeys: ["deleted1", "deleted2"],
          failed: ["acme/app#42"],
        },
      }),
    ),
  )
  expect(html).toContain("2 deleted; 1 could not be fully deleted")
  expect(html).toContain("/containers/detail?key=acme%2Fapp%2342")
  expect(html).not.toContain("deleted1")
  expect(html).toContain("Review each remaining run before retrying Destroy")
})

it("does not imply complete failure or success after a lost response", () => {
  const html = renderToStaticMarkup(createElement(ClearSessionsFeedback, { error: new Error("Network unavailable") }))
  expect(html).toContain("Cleanup could not be confirmed")
  expect(html).toContain("Some cleanup may have completed")
  expect(html).toContain("Network unavailable")
})
