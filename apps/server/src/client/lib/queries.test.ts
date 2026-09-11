import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, expect, it, vi } from "vitest"
import { api } from "./api"
import { useClearSessions, useDestroyContainer } from "./queries"

afterEach(() => vi.restoreAllMocks())

it("removes only successfully cleared detail caches and refreshes failures and related lists", async () => {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  const deleted = ["sessionDetail", "acme/app#42"]
  const failed = ["sessionDetail", "acme/app#99"]
  const other = ["sessionDetail", "acme/app#100"]
  for (const key of [deleted, failed, other]) client.setQueryData(key, { messages: ["saved"] })
  const lists = ["sessions", "events", "eventsGrouped", "eventStats", "agentWork"]
  for (const key of lists) client.setQueryData([key], { data: [] })
  vi.spyOn(api, "clearSessions").mockResolvedValue({
    ok: false,
    mode: "all",
    deleted: 1,
    destroyed: 1,
    deletedKeys: ["acme/app#42"],
    failed: ["acme/app#99"],
  })
  let mutation: ReturnType<typeof useClearSessions> | undefined
  function Probe() {
    mutation = useClearSessions()
    return null
  }
  try {
    renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Probe)))
    await mutation!.mutateAsync("all")
    expect(client.getQueryData(deleted)).toBeUndefined()
    expect(client.getQueryData(failed)).toEqual({ messages: ["saved"] })
    expect(client.getQueryState(failed)?.isInvalidated).toBe(true)
    expect(client.getQueryState(other)?.isInvalidated).toBe(false)
    for (const key of lists) expect(client.getQueryState([key])?.isInvalidated).toBe(true)
  } finally {
    client.clear()
  }
})

it("refreshes uncertain bulk cleanup after a network failure without discarding cached history", async () => {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: 2, retryDelay: 0 } } })
  const key = ["sessionDetail", "acme/app#42"]
  client.setQueryData(key, { messages: ["saved"] })
  client.setQueryData(["sessions"], { data: [] })
  vi.spyOn(api, "clearSessions").mockRejectedValue(new Error("Network unavailable"))
  let mutation: ReturnType<typeof useClearSessions> | undefined
  function Probe() {
    mutation = useClearSessions()
    return null
  }
  try {
    renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Probe)))
    await expect(mutation!.mutateAsync("all")).rejects.toThrow("Network unavailable")
    expect(client.getQueryData(key)).toEqual({ messages: ["saved"] })
    expect(client.getQueryState(key)?.isInvalidated).toBe(true)
    expect(client.getQueryState(["sessions"])?.isInvalidated).toBe(true)
    expect(api.clearSessions).toHaveBeenCalledTimes(1)
  } finally {
    client.clear()
  }
})

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
