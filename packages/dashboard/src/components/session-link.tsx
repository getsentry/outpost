import { getOpencodeUrl } from "@/lib/api"
import { opencodeSessionUrl } from "@/lib/format"
import { ExternalLink, Terminal } from "lucide-react"

export function SessionLink({
  sessionId,
  shareUrl,
  cwd,
  showLabel,
}: {
  sessionId: string | null | undefined
  shareUrl: string | null | undefined
  cwd: string | null | undefined
  showLabel?: boolean
}) {
  if (!sessionId?.trim()) return null
  const opencodeBaseUrl = getOpencodeUrl()
  const url = opencodeSessionUrl(sessionId, shareUrl, cwd, opencodeBaseUrl)
  if (!url) return null

  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
      title="OpenCode session"
    >
      <Terminal className="h-3 w-3" />
      {showLabel && <span className="text-xs">session</span>}
    </a>
  )
}

export function SessionLinkPrimary({
  sessionId,
  shareUrl,
  cwd,
}: {
  sessionId: string
  shareUrl: string | null | undefined
  cwd: string | null | undefined
}) {
  const opencodeBaseUrl = getOpencodeUrl()
  const url = opencodeSessionUrl(sessionId, shareUrl, cwd, opencodeBaseUrl)
  if (!url) return <span className="text-sm text-muted-foreground">N/A</span>
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 font-mono text-sm text-primary hover:underline"
      title={sessionId}
    >
      {sessionId.slice(0, 8)}... <ExternalLink className="h-3 w-3" />
    </a>
  )
}
