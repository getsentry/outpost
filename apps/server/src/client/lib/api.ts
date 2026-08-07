import { endpoint } from "@/lib/endpoint"

export type EventsParams = {
  page?: number
  limit?: number
  status?: string
  event?: string
  repo?: string
  entityKey?: string
}

export type SessionsParams = {
  page?: number
  limit?: number
}

// --- Session data types (matches OpenCode HTTP API shapes) ---

export type SessionInfo = {
  id: string
  title?: string
  cost?: number
  tokens?: { input?: number; output?: number }
  agent?: string
  model?: { id?: string }
  parentID?: string
  createdAt?: string
  updatedAt?: string
}

/** OpenCode v1.17.0 tool part state object. */
export type ToolState = {
  status?: string
  input?: Record<string, unknown>
  output?: unknown
  title?: string
  metadata?: Record<string, unknown>
  time?: unknown
}

export type MessagePart = {
  type: string
  text?: string
  // v1.17.0 tool parts: name in `tool`, details in `state` (an object).
  tool?: string
  state?: string | ToolState
  // Legacy `tool-invocation` shape (kept for back-compat).
  toolName?: string
  args?: Record<string, unknown>
  result?: unknown
  // Flue `dynamic-tool` shape (normalized server-side; kept for back-compat).
  input?: unknown
  output?: unknown
  errorText?: string
  toolCallId?: string
}

export type SessionMessage = {
  info?: {
    id?: string
    role?: string
    createdAt?: string
    // Assistant messages carry the agent/model/cost the session ran with. These
    // are the source of truth when the session object is a pending placeholder.
    agent?: string
    modelID?: string
    cost?: number
  }
  parts?: MessagePart[]
}

export type DisplayRunStatus = "working" | "idle" | "sync_unavailable" | "historical" | "unknown"

export type SessionDetailResponse = {
  entityKey: string
  createdAt: string
  updatedAt: string
  /** ISO timestamp of the stored snapshot used for status derivation. */
  statusObservedAt?: string
  /** Static note about sandbox scale-to-zero behavior. */
  sandboxHint?: string
  /** Operator-facing run status (stale busy → sync_unavailable, etc.). */
  status?: DisplayRunStatus
  sessions: SessionInfo[]
  sessionStatus: Record<string, { type: string }>
  messages: Record<string, SessionMessage[]>
  /** Present when Phase 2 Flue history pull failed; D1 snapshot may be stale/empty. */
  syncError?: string | null
  /** Present when a dashboard chat run's opening admit failed. */
  chatError?: string | null
  /** True once the opening chat prompt was admitted (follow-ups are safe). */
  chatAdmitted?: boolean
}

export type EventStats = {
  total: number
  pending: number
  dispatched: number
  completed: number
  failed: number
  stuck: number
  skipped: number
  last24h: number
}

export type SessionListItem = {
  entityKey: string
  createdAt: string
  updatedAt: string
  statusObservedAt?: string
  sandboxHint?: string
  sessionCount: number
  messageCount: number
  totalCost: number
  status: DisplayRunStatus | string
  title: string | null
  agent: string | null
  model: string | null
}

export const api = {
  async getEvents(params: EventsParams = {}) {
    const qs = new URLSearchParams()
    if (params.page != null) qs.set("page", String(params.page))
    if (params.limit != null) qs.set("limit", String(params.limit))
    if (params.status) qs.set("status", params.status)
    if (params.event) qs.set("event", params.event)
    if (params.repo) qs.set("repo", params.repo)
    if (params.entityKey) qs.set("entityKey", params.entityKey)

    const res = await fetch(`/api/events?${qs.toString()}`)
    if (!res.ok) throw new Error(`Failed to fetch events: ${res.status}`)
    return res.json()
  },

  async getEvent(id: string) {
    const res = await endpoint.api.events[":id"].$get({ param: { id } })
    if (!res.ok) throw new Error(`Failed to fetch event: ${res.status}`)
    return res.json()
  },

  async resendEvent(id: string) {
    const res = await endpoint.api.events[":id"].resend.$post({ param: { id } })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      throw new Error(body?.error ?? `Failed to resend event: ${res.status}`)
    }
    return res.json()
  },

  async getEventStats(): Promise<EventStats> {
    const res = await endpoint.api.events.stats.$get()
    if (!res.ok) throw new Error(`Failed to fetch stats: ${res.status}`)
    return res.json() as Promise<EventStats>
  },

  async clearEvents() {
    const res = await endpoint.api.events.$delete()
    if (!res.ok) throw new Error(`Failed to clear events: ${res.status}`)
    return res.json()
  },

  async getEventsGrouped() {
    const res = await endpoint.api.events.grouped.$get()
    if (!res.ok) throw new Error(`Failed to fetch grouped events: ${res.status}`)
    return res.json()
  },

  async getSessions(params: SessionsParams = {}): Promise<{
    data: SessionListItem[]
    pagination: { page: number; limit: number; total: number; totalPages: number }
  }> {
    const query: Record<string, string> = {}
    if (params.page != null) query.page = String(params.page)
    if (params.limit != null) query.limit = String(params.limit)

    const res = await endpoint.api.containers.sessions.$get({ query })
    if (!res.ok) throw new Error(`Failed to fetch sessions: ${res.status}`)
    return res.json() as Promise<{
      data: SessionListItem[]
      pagination: { page: number; limit: number; total: number; totalPages: number }
    }>
  },

  async getSessionDetail(entityKey: string): Promise<SessionDetailResponse> {
    const res = await fetch(`/api/containers/sessions/detail?entityKey=${encodeURIComponent(entityKey)}`)
    if (!res.ok) throw new Error(`Failed to fetch session: ${res.status}`)
    return res.json() as Promise<SessionDetailResponse>
  },

  async clearSessions(mode: "all" | "idle" = "all") {
    const res = await fetch(`/api/containers/sessions?mode=${mode}`, { method: "DELETE" })
    if (!res.ok) throw new Error(`Failed to clear sessions: ${res.status}`)
    return res.json() as Promise<{ ok: true; mode: string; deleted: number; destroyed: number }>
  },

  async deleteSession(entityKey: string) {
    const res = await fetch(`/api/containers/sessions/${encodeURIComponent(entityKey)}`, { method: "DELETE" })
    if (!res.ok) throw new Error(`Failed to delete session: ${res.status}`)
    return res.json()
  },

  async destroyContainer(entityKey: string) {
    const res = await fetch(`/api/containers/${encodeURIComponent(entityKey)}/destroy`, { method: "POST" })
    if (!res.ok) throw new Error(`Failed to destroy container: ${res.status}`)
    return res.json()
  },

  async getChatRepos(): Promise<{ repos: string[] }> {
    const res = await fetch("/api/containers/chat/repos")
    if (!res.ok) throw new Error(`Failed to fetch repositories: ${res.status}`)
    return res.json() as Promise<{ repos: string[] }>
  },

  async startChat(input: { repo: string; text: string }) {
    const res = await fetch("/api/containers/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      throw new Error(body?.error ?? `Failed to start chat: ${res.status}`)
    }
    return res.json() as Promise<{ ok: true; entityKey: string; repo: string }>
  },

  async sendPrompt(entityKey: string, text: string) {
    const res = await fetch(`/api/containers/${encodeURIComponent(entityKey)}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      throw new Error(body?.error ?? `Failed to send prompt: ${res.status}`)
    }
    return res.json() as Promise<{ ok: true; entityKey: string; conversationUrl?: string; submissionId?: string }>
  },
}
