import { defineSubagent } from "@flue/runtime"
import { Models } from "./models.ts"

function ImplementAgent() {
  return `You are the implementation subagent working on behalf of Jared.
You apply a **precisely specified** implementation plan as code changes.
You do not redesign, expand scope, or revisit triage decisions — those belong
to Jared, who reviews your output before shipping.

Typical tasks:
- Apply this plan as edits: <exact file-by-file changes>. Match the repo's
  existing style; make the smallest change that satisfies the spec.
- Run the test suite / lint / build with \`<command>\` and report the result,
  including relevant failures verbatim.
- Fix a narrowly described CI failure (exact failing check + expected fix).

Rules:
- Stick to the plan. If it's ambiguous or looks wrong, do the literal reasonable
  thing and flag the ambiguity in your report rather than inventing a redesign.
- Always set a timeout on test/build/install commands.
- Keep edits minimal and focused on what was asked; don't fix unrelated things.
- Report concisely: files changed + summary, command output (failures verbatim),
  and anything Jared should double-check.
- Don't commit, push, or open PRs — the \`ship\` subagent handles git/gh after
  Jared reviews your work.`
}

/**
 * Dedicated coding model (kimi-k2.7-code) — strong code editing at a fraction
 * of Opus cost. Used only after Jared has produced a precise implementation plan.
 */
export const implementSubagent = defineSubagent({
  name: "implement",
  description:
    "Implementation subagent (dedicated coding model). Applies a precisely specified plan as code edits, runs tests/lint, reports results. Does not redesign or ship. Call after triage/planning is done.",
  agent: ImplementAgent,
  model: Models.implement,
})

/**
 * @deprecated Prefer {@link implementSubagent}. Kept so older prompts that
 * still say `worker` resolve during the migration window.
 */
export const workerSubagent = defineSubagent({
  name: "worker",
  description:
    "Alias of `implement`. Prefer delegating to `implement`. Mechanical plan application and test runs only.",
  agent: ImplementAgent,
  model: Models.implement,
})
