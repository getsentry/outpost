import { ApiClient } from "@/lib/api"
import { useMemo, useSyncExternalStore } from "react"

const TOKEN_KEY = "opentower-token"
let listeners: Array<() => void> = []

function subscribe(listener: () => void) {
  listeners = [...listeners, listener]
  return () => {
    listeners = listeners.filter((l) => l !== listener)
  }
}

function getSnapshot(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function emitTokenChange() {
  for (const listener of listeners) listener()
}

export function useToken(): string | null {
  return useSyncExternalStore(subscribe, getSnapshot, () => null)
}

export function useApiClient(): ApiClient | null {
  const token = useToken()
  return useMemo(() => (token ? new ApiClient(token) : null), [token])
}
