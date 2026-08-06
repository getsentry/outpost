import { Plus } from "@phosphor-icons/react"
import { type ReactElement, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useChatRepos, useStartChat } from "@/client/lib/queries"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { isValidRepoSlug } from "@/lib/containers/chat-run"

/**
 * Start an agent run from the dashboard instead of waiting for a GitHub event.
 *
 * The repo picker lists repositories the GitHub App can reach. Free-text entry
 * stays available so a truncated or incomplete install list can't hide a repo
 * the App can still clone.
 */
export function NewChatDialog({ trigger }: { trigger?: ReactElement }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [repo, setRepo] = useState("")
  const [text, setText] = useState("")
  const [customRepo, setCustomRepo] = useState(false)

  const repos = useChatRepos(open)
  const startChat = useStartChat()

  const knownRepos = repos.data?.repos ?? []
  const useSelect = !customRepo && knownRepos.length > 0
  const canSubmit = isValidRepoSlug(repo.trim()) && text.trim().length > 0 && !startChat.isPending

  const handleOpenChange = (next: boolean) => {
    setOpen(next)
    if (!next) {
      startChat.reset()
      setRepo("")
      setText("")
      setCustomRepo(false)
    }
  }

  const handleSubmit = () => {
    if (!canSubmit) return
    startChat.mutate(
      { repo: repo.trim(), text: text.trim() },
      {
        onSuccess: ({ entityKey }) => {
          setText("")
          setRepo("")
          setCustomRepo(false)
          setOpen(false)
          navigate(`/containers/detail?key=${encodeURIComponent(entityKey)}`)
        },
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {trigger ? (
        <DialogTrigger render={trigger} />
      ) : (
        <DialogTrigger render={<Button size="sm" />}>
          <Plus data-icon="inline-start" />
          New chat
        </DialogTrigger>
      )}
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New chat</DialogTitle>
          <DialogDescription>
            Ask the agent to do something directly. It gets the same sandbox and tools as a run triggered by GitHub.
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="new-chat-repo">Repository</FieldLabel>
            {repos.isLoading ? (
              <div className="flex h-8 items-center gap-2 text-xs text-muted-foreground">
                <Spinner />
                Loading repositories…
              </div>
            ) : useSelect ? (
              <div className="flex flex-col gap-1.5">
                <Select value={repo || null} onValueChange={(value) => setRepo((value as string) ?? "")}>
                  <SelectTrigger id="new-chat-repo" className="w-full">
                    <SelectValue placeholder="Choose a repository" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {knownRepos.map((name) => (
                        <SelectItem key={name} value={name}>
                          {name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <button
                  type="button"
                  className="self-start text-[11px] text-muted-foreground underline-offset-2 hover:underline"
                  onClick={() => {
                    setCustomRepo(true)
                    setRepo("")
                  }}
                >
                  Enter a repo not listed
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                <Input
                  id="new-chat-repo"
                  value={repo}
                  onChange={(e) => setRepo(e.target.value)}
                  placeholder="owner/repo"
                  aria-invalid={repo.trim().length > 0 && !isValidRepoSlug(repo.trim())}
                />
                {knownRepos.length > 0 && (
                  <button
                    type="button"
                    className="self-start text-[11px] text-muted-foreground underline-offset-2 hover:underline"
                    onClick={() => {
                      setCustomRepo(false)
                      setRepo("")
                    }}
                  >
                    Pick from installed repos
                  </button>
                )}
              </div>
            )}
            <FieldDescription>The agent clones this repository into its sandbox before it starts.</FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="new-chat-message">First message</FieldLabel>
            <Textarea
              id="new-chat-message"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  handleSubmit()
                }
              }}
              rows={5}
              placeholder="Look into the flaky retention test and open a PR if you find the cause…"
              aria-invalid={startChat.isError || undefined}
              aria-describedby={startChat.isError ? "new-chat-error" : undefined}
            />
            <FieldDescription>⌘/Ctrl+Enter to start. You can keep talking to the agent once it runs.</FieldDescription>
          </Field>
        </FieldGroup>

        {startChat.isError && (
          <p id="new-chat-error" role="alert" className="text-xs text-destructive">
            {startChat.error instanceof Error ? startChat.error.message : "Failed to start chat"}
          </p>
        )}

        <DialogFooter>
          <DialogClose render={<Button variant="outline" />} disabled={startChat.isPending}>
            Cancel
          </DialogClose>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {startChat.isPending && <Spinner data-icon="inline-start" />}
            {startChat.isPending ? "Starting…" : "Start chat"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
