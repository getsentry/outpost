const STORAGE_KEY = "opentower-servers"

export type ServerConfig = {
  id: string
  name: string
  url: string
  token: string
}

export function loadServers(): ServerConfig[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    return JSON.parse(raw) as ServerConfig[]
  } catch {
    return []
  }
}

export function saveServers(servers: ServerConfig[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(servers))
}

export function addServer(server: Omit<ServerConfig, "id">): ServerConfig {
  const servers = loadServers()
  const entry: ServerConfig = { ...server, id: crypto.randomUUID() }
  servers.push(entry)
  saveServers(servers)
  return entry
}

export function removeServer(id: string): void {
  const servers = loadServers().filter((s) => s.id !== id)
  saveServers(servers)
}
