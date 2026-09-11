import { QueryClient } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"
import { subscribeSessionStream } from "./session-stream"

class TestSource extends EventTarget {
  static CLOSED = 2
  static instances: TestSource[] = []
  readyState = 1
  onerror: (() => void) | null = null
  url: string
  constructor(url: string) {
    super()
    this.url = url
    TestSource.instances.push(this)
  }
  close() {
    this.readyState = TestSource.CLOSED
  }
  emit(type: string, data: unknown) {
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }))
  }
}

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  TestSource.instances = []
  vi.unstubAllGlobals()
})

function fixture() {
  vi.stubGlobal("EventSource", TestSource)
  const client = new QueryClient()
  const key = ["sessionDetail", "acme/app#42"]
  client.setQueryData(key, { messages: ["old"] })
  client.setQueryData(["sessionDetail", "other"], { messages: ["keep"] })
  cleanups.push(
    subscribeSessionStream(client, "acme/app#42", () => {}),
    () => client.clear(),
  )
  return { client, key, source: TestSource.instances[0] }
}

describe("session stream teardown", () => {
  it("does not restore messages after Destroy evicts the session cache", () => {
    const { client, key, source } = fixture()
    client.removeQueries({ queryKey: key, exact: true })
    source.emit("snapshot", { messages: ["late"] })
    expect(client.getQueryData(key)).toBeUndefined()
    expect(source.readyState).toBe(TestSource.CLOSED)
    expect(client.getQueryData(["sessionDetail", "other"])).toEqual({ messages: ["keep"] })
  })

  it("clears stale messages when the server reports that the session is gone", () => {
    const { client, key, source } = fixture()
    source.emit("gone", "session destroyed")
    source.emit("snapshot", { messages: ["late"] })
    expect(client.getQueryData(key)).toBeUndefined()
    expect(source.readyState).toBe(TestSource.CLOSED)
  })

  it("still applies live snapshots for an existing session", () => {
    const { client, key, source } = fixture()
    source.emit("snapshot", { messages: ["new"] })
    expect(client.getQueryData(key)).toEqual({ messages: ["new"] })
  })
})
