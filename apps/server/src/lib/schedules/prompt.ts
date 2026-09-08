import { scheduledRunMarker } from "./run-key"

export function formatScheduledPrompt(opts: {
  runId: string
  scheduleName: string
  repo: string
  intendedAt: string
  text: string
}): string {
  return `Scheduled run: ${opts.scheduleName}
Run ID: ${opts.runId}
Repository: ${opts.repo}
Intended time: ${opts.intendedAt}

This is an operator-configured recurring task, not a GitHub webhook. Follow the
operator prompt below as the complete requested behavior. Do not invent a
requirement to create a PR, label, issue, or merge unless the prompt asks for
it. If you create a GitHub PR or issue, include this exact hidden marker in its
body so Outpost can show the artifact in this run's history:
${scheduledRunMarker(opts.runId)}

Operator prompt:
${opts.text}`
}
