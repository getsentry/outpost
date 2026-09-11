import { Link } from "react-router-dom"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import type { ClearSessionsResult } from "@/lib/containers/clear-sessions-result"

export function ClearSessionsFeedback({ result, error }: { result?: ClearSessionsResult; error: Error | null }) {
  if (error)
    return (
      <Alert variant="destructive">
        <AlertTitle>Cleanup could not be confirmed</AlertTitle>
        <AlertDescription>
          <p>{error.message}</p>
          <p>Some cleanup may have completed. Close this dialog and check the remaining runs before trying again.</p>
        </AlertDescription>
      </Alert>
    )
  if (!result || result.mode !== "all" || result.ok) return null
  return (
    <Alert variant="destructive">
      <AlertTitle>Some runs still need attention</AlertTitle>
      <AlertDescription>
        <p>
          {result.deleted} deleted; {result.failed.length} could not be fully deleted.
        </p>
        <p>Cleanup may be incomplete or a run may have restarted. Review each remaining run before retrying Destroy.</p>
        <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
          {result.failed.map((entityKey) => (
            <li key={entityKey}>
              <Link className="break-all underline" to={`/containers/detail?key=${encodeURIComponent(entityKey)}`}>
                {entityKey}
              </Link>
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  )
}
