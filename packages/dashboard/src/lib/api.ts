export type EntityRow = {
  entity_key: string
  repo: string
  number: number
  kind: "issue" | "pull_request"
  session_id: string
  share_url: string | null
  cwd: string | null
  agent: string
  created_at: string
  updated_at: string
}

export type DispatchRow = {
  id: string
  entity_key: string | null
  session_id: string | null
  share_url: string | null
  cwd: string | null
  trigger_name: string
  event: string
  delivery_id: string
  status: "started" | "completed" | "failed" | "timeout"
  created_at: string
  completed_at: string | null
}

export type LinkRow = {
  source_key: string
  target_key: string
  relation: string
  created_at: string
}

export type StatsResult = {
  total_entities: number
  total_dispatches: number
  status_counts: Record<string, number>
  recent_24h: number
}

export type EntityDetail = {
  entity: EntityRow
  dispatches: DispatchRow[]
  links: LinkRow[]
}

export type PaginatedEntities = {
  entities: EntityRow[]
  next_cursor: string | null
}

export type PaginatedDispatches = {
  dispatches: DispatchRow[]
  next_cursor: string | null
}

export type CronJobRow = {
  id: string
  name: string
  cron_expression: string
  prompt: string
  entity_key: string | null
  agent: string
  timezone: string
  enabled: number
  run_once: number
  created_by: string
  created_at: string
  updated_at: string
  last_run_at: string | null
  next_run_at: string | null
}

export type CronExecutionRow = {
  id: string
  cron_job_id: string
  dispatch_id: string | null
  status: "pending" | "running" | "completed" | "failed" | "skipped"
  scheduled_at: string
  started_at: string | null
  completed_at: string | null
}

export type PaginatedCronJobs = {
  jobs: CronJobRow[]
  next_cursor: string | null
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = "ApiError"
    this.status = status
  }
}

const TOKEN_KEY = "opentower-token"
const OPENCODE_URL_KEY = "opentower-opencode-url"

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

export function setOpencodeUrl(url: string): void {
  if (url) {
    localStorage.setItem(OPENCODE_URL_KEY, url)
  } else {
    localStorage.removeItem(OPENCODE_URL_KEY)
  }
}

export function getOpencodeUrl(): string | null {
  return localStorage.getItem(OPENCODE_URL_KEY)
}

export function clearOpencodeUrl(): void {
  localStorage.removeItem(OPENCODE_URL_KEY)
}

export class ApiClient {
  private token: string

  constructor(token: string) {
    this.token = token
  }

  private async request<T>(
    path: string,
    params?: Record<string, string>,
    options?: { method?: string; body?: unknown },
  ): Promise<T> {
    const url = new URL(path, window.location.origin)
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v) url.searchParams.set(k, v)
      }
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` }
    const fetchOptions: RequestInit = { headers }

    if (options?.method) {
      fetchOptions.method = options.method
    }
    if (options?.body !== undefined) {
      headers["Content-Type"] = "application/json"
      fetchOptions.body = JSON.stringify(options.body)
    }

    const res = await fetch(url.toString(), fetchOptions)
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }))
      throw new ApiError(res.status, (body as { error?: string }).error ?? res.statusText)
    }
    return res.json() as Promise<T>
  }

  stats(): Promise<StatsResult> {
    return this.request("/api/stats")
  }

  entities(opts?: { limit?: number; cursor?: string; repo?: string }): Promise<PaginatedEntities> {
    return this.request("/api/entities", {
      limit: String(opts?.limit ?? 50),
      cursor: opts?.cursor ?? "",
      repo: opts?.repo ?? "",
    })
  }

  entity(key: string): Promise<EntityDetail> {
    return this.request(`/api/entities/${encodeURIComponent(key)}`)
  }

  dispatches(opts?: {
    limit?: number
    cursor?: string
    status?: string
    event?: string
  }): Promise<PaginatedDispatches> {
    return this.request("/api/dispatches", {
      limit: String(opts?.limit ?? 50),
      cursor: opts?.cursor ?? "",
      status: opts?.status ?? "",
      event: opts?.event ?? "",
    })
  }

  // Cron job methods
  cronJobs(opts?: { limit?: number; cursor?: string; enabled?: boolean }): Promise<PaginatedCronJobs> {
    return this.request("/api/cron", {
      limit: String(opts?.limit ?? 50),
      cursor: opts?.cursor ?? "",
      enabled: opts?.enabled !== undefined ? String(opts.enabled) : "",
    })
  }

  cronJob(id: string): Promise<CronJobRow> {
    return this.request(`/api/cron/${encodeURIComponent(id)}`)
  }

  createCronJob(job: {
    name: string
    cron_expression: string
    prompt: string
    agent: string
    entity_key?: string | null
    timezone?: string
    run_once?: boolean
  }): Promise<{ created: CronJobRow }> {
    return this.request("/api/cron", undefined, { method: "POST", body: job })
  }

  updateCronJob(
    id: string,
    updates: Partial<{
      name: string
      cron_expression: string
      prompt: string
      agent: string
      entity_key: string | null
      timezone: string
      enabled: boolean
    }>,
  ): Promise<CronJobRow> {
    return this.request(`/api/cron/${encodeURIComponent(id)}`, undefined, { method: "PUT", body: updates })
  }

  deleteCronJob(id: string): Promise<{ deleted: string }> {
    return this.request(`/api/cron/${encodeURIComponent(id)}`, undefined, { method: "DELETE" })
  }

  triggerCronJob(id: string): Promise<{ triggered: string; message: string }> {
    return this.request(`/api/cron/${encodeURIComponent(id)}/trigger`, undefined, { method: "POST" })
  }

  cronExecutions(id: string, opts?: { limit?: number }): Promise<{ executions: CronExecutionRow[] }> {
    return this.request(`/api/cron/${encodeURIComponent(id)}/executions`, {
      limit: String(opts?.limit ?? 50),
    })
  }

  // Retention settings
  getRetention(): Promise<{ retention_days: number }> {
    return this.request("/api/retention")
  }

  setRetention(days: number): Promise<{ retention_days: number }> {
    return this.request("/api/retention", undefined, { method: "PUT", body: { retention_days: days } })
  }

  pruneNow(): Promise<{
    pruned: { dispatches: number; entities: number; cronExecutions: number; links: number }
    retention_days: number
  }> {
    return this.request("/api/retention/prune", undefined, { method: "POST" })
  }

  static async healthz(): Promise<boolean> {
    try {
      const res = await fetch("/healthz")
      return res.ok
    } catch {
      return false
    }
  }

  static async testToken(token: string): Promise<boolean> {
    try {
      const res = await fetch("/api/stats", {
        headers: { Authorization: `Bearer ${token}` },
      })
      return res.ok
    } catch {
      return false
    }
  }
}
