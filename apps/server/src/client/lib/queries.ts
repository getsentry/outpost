import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { authClient } from "@/lib/endpoint"
import { api, type EventsParams, type SessionDetailResponse, type SessionsParams } from "./api"

export function useSession() {
  return useQuery({
    queryKey: ["session"],
    queryFn: async () => {
      const { data, error } = await authClient.getSession()
      if (error) throw error
      return data
    },
    retry: false,
    staleTime: 5 * 60 * 1000,
  })
}

export function useEvents(params: EventsParams = {}, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ["events", params],
    queryFn: () => api.getEvents(params),
    enabled: options.enabled ?? true,
    placeholderData: keepPreviousData,
    refetchInterval: 10_000,
  })
}

export function useEvent(id: string) {
  return useQuery({
    queryKey: ["event", id],
    queryFn: () => api.getEvent(id),
    enabled: !!id,
  })
}

export function useEventStats() {
  return useQuery({
    queryKey: ["eventStats"],
    queryFn: () => api.getEventStats(),
    refetchInterval: 10_000,
  })
}

export function useEventsGrouped() {
  return useQuery({
    queryKey: ["eventsGrouped"],
    queryFn: () => api.getEventsGrouped(),
    refetchInterval: 10_000,
  })
}

export function useResendEvent() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.resendEvent(id),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: ["event", id] })
      queryClient.invalidateQueries({ queryKey: ["events"] })
      queryClient.invalidateQueries({ queryKey: ["sessions"] })
    },
  })
}

export function useClearEvents() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.clearEvents(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["events"] })
      queryClient.invalidateQueries({ queryKey: ["eventStats"] })
      queryClient.invalidateQueries({ queryKey: ["eventsGrouped"] })
    },
  })
}

export function useSessions(params: SessionsParams = {}) {
  return useQuery({
    queryKey: ["sessions", params],
    queryFn: () => api.getSessions(params),
    placeholderData: keepPreviousData,
    refetchInterval: 10_000,
  })
}

/**
 * Session detail with a live SSE transcript.
 *
 * Server-Sent Events push fresh snapshots straight into the query cache, so the
 * UI updates the instant the agent does. Polling stays wired as a fallback —
 * slow while the stream is healthy, fast (busy-aware) whenever it drops — so the
 * page keeps working even if EventSource is unavailable or the connection fails.
 */
export function useSessionDetail(entityKey: string) {
  const queryClient = useQueryClient()
  const [streaming, setStreaming] = useState(false)

  const query = useQuery({
    queryKey: ["sessionDetail", entityKey],
    queryFn: () => api.getSessionDetail(entityKey),
    enabled: !!entityKey,
    refetchInterval: (q) => {
      // Stream is live: it delivers updates, so only keep a slow safety poll.
      if (streaming) return 30_000
      // Fallback polling: fast while busy so tool calls / text appear promptly.
      const status = q.state.data?.sessionStatus
      const busy = status && Object.values(status).some((s) => s?.type === "busy")
      return busy ? 2_000 : 10_000
    },
  })

  useEffect(() => {
    if (!entityKey) return
    if (typeof window === "undefined" || typeof EventSource === "undefined") return

    let source: EventSource | null = null
    let cancelled = false
    let retry: ReturnType<typeof setTimeout> | undefined

    const connect = () => {
      if (cancelled) return
      source = new EventSource(`/api/containers/sessions/stream?entityKey=${encodeURIComponent(entityKey)}`)

      source.addEventListener("snapshot", (ev) => {
        try {
          const payload = JSON.parse((ev as MessageEvent).data) as SessionDetailResponse
          queryClient.setQueryData(["sessionDetail", entityKey], payload)
          setStreaming(true)
        } catch {
          /* ignore malformed frame */
        }
      })

      // Server ended the session (not found) — stop and let polling take over.
      source.addEventListener("gone", () => {
        cancelled = true
        setStreaming(false)
        source?.close()
      })

      source.onerror = () => {
        setStreaming(false)
        // EventSource auto-reconnects while CONNECTING (e.g. our lifetime cap
        // closed the response). If it gave up (CLOSED), retry on a slow timer.
        if (source && source.readyState === EventSource.CLOSED && !cancelled) {
          source.close()
          retry = setTimeout(connect, 15_000)
        }
      }
    }

    connect()

    return () => {
      cancelled = true
      setStreaming(false)
      if (retry) clearTimeout(retry)
      source?.close()
    }
  }, [entityKey, queryClient])

  return { ...query, streaming }
}

export function useSendPrompt(entityKey: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (text: string) => api.sendPrompt(entityKey, text),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sessionDetail", entityKey] })
      queryClient.invalidateQueries({ queryKey: ["sessions"] })
    },
  })
}

/** Repos the agent can be pointed at. Only fetched while the picker is open. */
export function useChatRepos(enabled = true) {
  return useQuery({
    queryKey: ["chatRepos"],
    queryFn: () => api.getChatRepos(),
    enabled,
    staleTime: 5 * 60 * 1000,
  })
}

export function useStartChat() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { repo: string; text: string }) => api.startChat(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sessions"] })
    },
  })
}

export function useClearSessions() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (mode: "all" | "idle" = "all") => api.clearSessions(mode),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sessions"] })
    },
  })
}

export function useDeleteSession() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (entityKey: string) => api.deleteSession(entityKey),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sessions"] })
    },
  })
}

export function useDestroyContainer() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (entityKey: string) => api.destroyContainer(entityKey),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sessions"] })
      queryClient.invalidateQueries({ queryKey: ["sessionDetail"] })
    },
  })
}
