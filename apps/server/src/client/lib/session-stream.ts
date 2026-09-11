import type { QueryClient } from "@tanstack/react-query"
import type { SessionDetailResponse } from "./api"

/** Subscribe to the existing session stream; shared with the hook and lifecycle tests. */
export function subscribeSessionStream(
  queryClient: QueryClient,
  entityKey: string,
  setStreaming: (live: boolean) => void,
) {
  let source: EventSource | null = null
  let cancelled = false
  let retry: ReturnType<typeof setTimeout> | undefined
  const queryKey = ["sessionDetail", entityKey]
  const stop = () => {
    cancelled = true
    setStreaming(false)
    if (retry) clearTimeout(retry)
    source?.close()
  }
  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    if (
      event.type === "removed" &&
      event.query.queryKey[0] === "sessionDetail" &&
      event.query.queryKey[1] === entityKey
    )
      stop()
  })

  const connect = () => {
    if (cancelled) return
    source = new EventSource(`/api/containers/sessions/stream?entityKey=${encodeURIComponent(entityKey)}`)
    source.addEventListener("snapshot", (ev) => {
      if (cancelled) return
      try {
        const payload = JSON.parse((ev as MessageEvent).data) as SessionDetailResponse
        queryClient.setQueryData(queryKey, payload)
        setStreaming(true)
      } catch {
        /* ignore malformed frame */
      }
    })
    source.addEventListener("gone", () => {
      stop()
      void queryClient.cancelQueries({ queryKey, exact: true })
      queryClient.removeQueries({ queryKey, exact: true })
    })
    source.onerror = () => {
      setStreaming(false)
      if (source && source.readyState === EventSource.CLOSED && !cancelled) {
        source.close()
        retry = setTimeout(connect, 15_000)
      }
    }
  }
  connect()
  return () => {
    unsubscribe()
    stop()
  }
}
