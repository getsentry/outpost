import { showToast } from "@/components/toast"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useApiClient } from "@/hooks/use-api"
import { getOpencodeUrl, setOpencodeUrl } from "@/lib/api"
import { isValidUrl } from "@/lib/validation"
import { Loader2, Settings } from "lucide-react"
import { useEffect, useState } from "react"

interface SettingsDialogProps {
  collapsed?: boolean
}

export function SettingsDialog({ collapsed }: SettingsDialogProps) {
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState("")
  const [retentionDays, setRetentionDays] = useState("")
  const [error, setError] = useState("")
  const [saving, setSaving] = useState(false)
  const [pruning, setPruning] = useState(false)
  const client = useApiClient()

  useEffect(() => {
    if (open) {
      setUrl(getOpencodeUrl() || "")
      setError("")
      // Load current retention setting
      if (client) {
        client.getRetention().then(
          (r) => setRetentionDays(String(r.retention_days)),
          () => setRetentionDays("30"),
        )
      }
    }
  }, [open, client])

  async function handleSave() {
    const trimmed = url.trim()
    if (trimmed && !isValidUrl(trimmed)) {
      setError("Invalid URL format. Must be http:// or https://")
      return
    }

    const days = Number(retentionDays)
    if (client && (!Number.isFinite(days) || days < 1 || days > 365)) {
      setError("Retention must be between 1 and 365 days")
      return
    }

    setSaving(true)
    try {
      setOpencodeUrl(trimmed)
      if (client && Number.isFinite(days) && days >= 1) {
        await client.setRetention(Math.floor(days))
      }
      showToast("Settings saved")
      setOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save settings")
    } finally {
      setSaving(false)
    }
  }

  async function handlePrune() {
    if (!client) return
    const days = Number(retentionDays)
    if (!Number.isFinite(days) || days < 1 || days > 365) {
      showToast("Set a valid retention period (1-365 days) first", "error")
      return
    }
    setPruning(true)
    try {
      // Save the current retention value before pruning so the server
      // uses the value the user sees in the input field.
      await client.setRetention(Math.floor(days))
      const result = await client.pruneNow()
      const { dispatches, entities, cron_executions, links } = result.pruned
      const total = dispatches + entities + cron_executions + links
      showToast(
        total > 0
          ? `Pruned ${dispatches} dispatches, ${entities} entities, ${cron_executions} cron executions, ${links} links`
          : "Nothing to prune",
      )
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to prune", "error")
    } finally {
      setPruning(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {collapsed ? (
          <button
            type="button"
            className="mx-auto flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            title="Settings"
          >
            <Settings className="h-4 w-4" />
          </button>
        ) : (
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            <Settings className="h-4 w-4" />
            Settings
          </button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Configure your OpenCode deployment and data retention.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="opencode-url">OpenCode URL</Label>
            <Input
              id="opencode-url"
              type="url"
              placeholder="https://your-opencode-instance.com"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value)
                setError("")
              }}
            />
            <p className="text-xs text-muted-foreground">
              Base URL for your OpenCode instance. Session links will open in this instance.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="retention-days">Data Retention (days)</Label>
            <div className="flex items-center gap-2">
              <Input
                id="retention-days"
                type="number"
                min={1}
                max={365}
                placeholder="30"
                value={retentionDays}
                onChange={(e) => {
                  setRetentionDays(e.target.value)
                  setError("")
                }}
                className="w-24"
              />
              <Button type="button" variant="outline" size="sm" onClick={handlePrune} disabled={pruning}>
                {pruning && <Loader2 className="h-4 w-4 animate-spin" />}
                Prune now
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Dispatches, orphaned entities, and cron executions older than this are automatically pruned.
            </p>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
