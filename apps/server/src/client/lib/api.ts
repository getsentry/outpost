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

  async getSessions(params: SessionsParams = {}) {
    const query: Record<string, string> = {}
    if (params.page != null) query.page = String(params.page)
    if (params.limit != null) query.limit = String(params.limit)

    const res = await endpoint.api.sessions.$get({ query })
    if (!res.ok) throw new Error(`Failed to fetch sessions: ${res.status}`)
    return res.json()
  },

  async getSessionDetail(entityKey: string) {
    const res = await endpoint.api.sessions[":entityKey"].$get({
      param: { entityKey },
    })
    if (!res.ok) throw new Error(`Failed to fetch session: ${res.status}`)
    return res.json()
  },
}
