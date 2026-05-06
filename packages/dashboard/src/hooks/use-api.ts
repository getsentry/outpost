import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import { ApiClient } from "@/lib/api"
import { useServers } from "./use-servers"

export function useApiClient(): ApiClient | null {
  const { activeServer } = useServers()
  return useMemo(
    () => activeServer ? new ApiClient(activeServer.url, activeServer.token) : null,
    [activeServer],
  )
}

export function useQuery<T>(
  fetcher: ((client: ApiClient) => Promise<T>) | null,
  deps: unknown[] = [],
) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const client = useApiClient()
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refetch = useCallback(() => {
    if (!client || !fetcher) {
      setLoading(false)
      return
    }
    setLoading(true)
    fetcher(client)
      .then((result) => {
        setData(result)
        setError(null)
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Unknown error")
      })
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, fetcher, ...deps])

  useEffect(() => {
    refetch()
    intervalRef.current = setInterval(refetch, 30_000)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [refetch])

  return { data, loading, error, refetch }
}
