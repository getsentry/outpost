import { useState, useCallback, useSyncExternalStore } from "react"
import { type ServerConfig, loadServers, saveServers } from "@/lib/servers"

let listeners: Array<() => void> = []

function emitChange() {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners = [...listeners, listener]
  return () => {
    listeners = listeners.filter((l) => l !== listener)
  }
}

function getSnapshot(): ServerConfig[] {
  return loadServers()
}

export function useServers() {
  const servers = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const [activeId, setActiveIdState] = useState<string | null>(() => {
    const stored = localStorage.getItem("opentower-active-server")
    const all = loadServers()
    if (stored && all.some((s) => s.id === stored)) return stored
    return all.length > 0 ? all[0].id : null
  })

  const activeServer = servers.find((s) => s.id === activeId) ?? null

  const setActiveId = useCallback((id: string | null) => {
    setActiveIdState(id)
    if (id) localStorage.setItem("opentower-active-server", id)
    else localStorage.removeItem("opentower-active-server")
  }, [])

  const add = useCallback(
    (server: Omit<ServerConfig, "id">) => {
      const all = loadServers()
      const entry: ServerConfig = { ...server, id: crypto.randomUUID() }
      all.push(entry)
      saveServers(all)
      emitChange()
      if (!activeId) setActiveId(entry.id)
      return entry
    },
    [activeId, setActiveId],
  )

  const remove = useCallback(
    (id: string) => {
      const all = loadServers().filter((s) => s.id !== id)
      saveServers(all)
      emitChange()
      if (activeId === id) {
        setActiveId(all.length > 0 ? all[0].id : null)
      }
    },
    [activeId, setActiveId],
  )

  return { servers, activeServer, activeId, setActiveId, add, remove }
}
