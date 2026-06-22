import { endpoint } from "@/lib/endpoint"

export type EventsParams = {
  page?: number
  limit?: number
  status?: string
  event?: string
  repo?: string
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

export type SessionDetailResponse = {
  entityKey: string
  createdAt: string
  updatedAt: string
  sessions: SessionInfo[]
  sessionStatus: Record<string, { type: string }>
  messages: Record<string, SessionMessage[]>
  logs: string
}

export type SessionListItem = {
  entityKey: string
  createdAt: string
  updatedAt: string
  sessionCount: number
  messageCount: number
  totalCost: number
  status: string
  title: string | null
  agent: string | null
  model: string | null
}

export const api = {
  async getEvents(params: EventsParams = {}) {
    const query: Record<string, string> = {}
    if (params.page != null) query.page = String(params.page)
    if (params.limit != null) query.limit = String(params.limit)
    if (params.status) query.status = params.status
    if (params.event) query.event = params.event
    if (params.repo) query.repo = params.repo

    const res = await endpoint.api.events.$get({ query })
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

  async getEventStats() {
    const res = await endpoint.api.events.stats.$get()
    if (!res.ok) throw new Error(`Failed to fetch stats: ${res.status}`)
    return res.json()
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

  async clearSessions() {
    const res = await fetch("/api/containers/sessions", { method: "DELETE" })
    if (!res.ok) throw new Error(`Failed to clear sessions: ${res.status}`)
    return res.json()
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
}
