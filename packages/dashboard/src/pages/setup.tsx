import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { emitTokenChange } from "@/hooks/use-api"
import { ApiClient, setOpencodeUrl, setToken } from "@/lib/api"
import { Loader2 } from "lucide-react"
import { useState } from "react"
import { useNavigate } from "react-router-dom"

export default function SetupPage() {
  const navigate = useNavigate()
  const [token, setTokenInput] = useState("")
  const [opencodeUrl, setOpencodeUrlInput] = useState("")
  const [error, setError] = useState("")
  const [testing, setTesting] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError("")

    const trimmedToken = token.trim()
    if (!trimmedToken) {
      setError("Token is required")
      return
    }

    const trimmedUrl = opencodeUrl.trim()
    if (trimmedUrl && !isValidUrl(trimmedUrl)) {
      setError("Invalid OpenCode URL format")
      return
    }

    setTesting(true)
    try {
      const ok = await ApiClient.testToken(trimmedToken)
      if (!ok) {
        setError("Invalid token or server unreachable")
        return
      }
      setToken(trimmedToken)
      setOpencodeUrl(trimmedUrl)
      emitTokenChange()
      navigate("/")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection failed")
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <span className="text-2xl" role="img" aria-label="outpost">
              🏕️
            </span>
          </div>
          <CardTitle className="text-2xl">Outpost Dashboard</CardTitle>
          <CardDescription>Enter your API token and OpenCode URL to access the dashboard.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="token">API Token</Label>
              <Input
                id="token"
                type="password"
                placeholder="Enter your OPENTOWER_API_TOKEN"
                value={token}
                onChange={(e) => setTokenInput(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="opencodeUrl">OpenCode URL</Label>
              <Input
                id="opencodeUrl"
                type="url"
                placeholder="https://your-opencode-instance.com"
                value={opencodeUrl}
                onChange={(e) => setOpencodeUrlInput(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Base URL for your OpenCode instance. Session links will open in this instance.
              </p>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={testing}>
              {testing && <Loader2 className="animate-spin" />}
              {testing ? "Verifying..." : "Connect"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

function isValidUrl(str: string): boolean {
  try {
    const url = new URL(str)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}
