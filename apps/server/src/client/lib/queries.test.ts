import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, expect, it, vi } from "vitest"
import { api } from "./api"
import { useDestroyContainer } from "./queries"

afterEach(() => vi.restoreAllMocks())

it("refreshes partial cleanup state after failed Destroy without deleting the saved transcript", async () => {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  const key = ["sessionDetail", "acme/app#42"]
  const other = ["sessionDetail", "acme/app#99"]
  client.setQueryData(key, { messages: ["saved"] })
  client.setQueryData(other, { messages: ["unrelated"] })
  client.setQueryData(["sessions"], { data: [] })
  vi.spyOn(api, "destroyContainer").mockRejectedValue(new Error("Cleanup incomplete"))
  let mutation: ReturnType<typeof useDestroyContainer> | undefined
  function Probe() {
    mutation = useDestroyContainer()
    return null
  }
  try {
    renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Probe)))
    await expect(mutation!.mutateAsync("acme/app#42")).rejects.toThrow("Cleanup incomplete")
    expect(client.getQueryState(key)?.isInvalidated).toBe(true)
    expect(client.getQueryState(["sessions"])?.isInvalidated).toBe(true)
    expect(client.getQueryData(key)).toEqual({ messages: ["saved"] })
    expect(client.getQueryState(other)?.isInvalidated).toBe(false)
  } finally {
    client.clear()
  }
})
