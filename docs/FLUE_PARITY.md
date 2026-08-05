# Flue Parity Spike (Phase 0)

Findings from validating Flue against Outpost's OpenCode-based harness requirements.

## Packages pinned

| Package | Version | Role |
| --- | --- | --- |
| `@flue/runtime` | 2.0.1 | Harness, sessions, tools, sandboxes |
| `@flue/vite` | 2.0.1 | Vite plugin (`flue()`) for Node + Cloudflare builds |
| `@flue/sdk` | 2.0.1 | Client for `send` / `wait` / `history` / `observe` |
| `@flue/cli` | 2.0.1 | `flue run` / `flue add` / docs |
| `agents` | 0.14.x | Cloudflare Agents SDK (Flue Cloudflare target) |
| `@loreai/gateway` / `@loreai/pi` | 0.40.0 | Lore LLM proxy + Pi extension |

## Capability checklist

| Requirement | OpenCode today | Flue | Verdict |
| --- | --- | --- | --- |
| Primary agent + model tiering | `jared.md` frontmatter `model:` | `useModel(Models.triage)` + per-role `defineSubagent` | Pass |
| Subagents (`explore`, `implement`, `ship`) | `mode: subagent` + `task` tool | `useSubagent` with Opus 4.6 / Sonnet / xAI Grok | Pass |
| Skills as markdown | `~/.config/opencode/skills/*/SKILL.md` | Workspace `.agents/skills/*/SKILL.md` discovered at sandbox init | Pass |
| Multi-repo git / `gh` / PRs | Full Linux in Cloudflare Sandbox | `useSandbox(cloudflareSandbox(getSandbox(...)))` or Node `local()` | Pass (needs container sandbox, not virtual) |
| HTTP prompt admission | `POST /session/:id/prompt_async` | `POST /agents/jared/:id` with `{ kind: "user", body }` → 202 | Pass |
| Session read / stream | OpenCode session/message APIs | `GET /agents/jared/:id?view=history` + Durable Streams | Pass |
| Background / cron | Skill-documented `run_once` (not Worker cron) | Node: in-process cron + `dispatch`; CF: Cron Triggers or DO `schedule()` / `scheduleEvery()` via `extend()` | Pass |
| Lore | Comment in Dockerfile; not installed | Native `@loreai/pi` + gateway proxy; route model base URL through Lore | Pass (in container); Phase 2 needs standalone Lore service |
| Observability | Manual D1 scrape + dashboard | Native Sentry / OpenTelemetry adapters + Workers traces | Pass |
| Cloudflare fit | Worker orchestrates container that runs `opencode serve` | Agent brain = Durable Object; container = plain Linux sandbox | Pass — **this is the compute win** |

## Model roster (cost / quality tiers)

Defined in [`apps/server/src/agents/models.ts`](../apps/server/src/agents/models.ts):

| Role | Agent | Model | Owns |
| --- | --- | --- | --- |
| Triage / plan / go-no-go | `jared` (primary) | `openrouter/anthropic/claude-opus-4.8` | Routing, root-cause, precise plan, final review |
| Explore | `explore` subagent | `openrouter/anthropic/claude-sonnet-4.6` | Read-only codebase brief |
| Implement | `implement` subagent | `openrouter/anthropic/claude-opus-4.6` | Apply plan as edits, run tests |
| Ship | `ship` subagent | `openrouter/x-ai/grok-code-fast-1` | Commit, push, open/update draft PR |

Pipeline: **triage (4.8) → explore (Sonnet) → plan (4.8) → implement (4.6) → review (4.8) → ship (Grok)**.

`worker` remains as a deprecated alias of `implement` for older prompts.

## Topology recommendation

```
Phase 1 (de-risk): Worker → Sandbox container → Flue Node server (:4096) + Lore gateway
Phase 2 (target):  Worker/Flue DO (brain + session + cron) → thin Sandbox (git/gh only)
                   DO model traffic → standalone Lore gateway (SQLite volume)
```

## Lore constraint

Lore is a long-lived HTTP proxy with a local SQLite DB (`~/.local/share/lore/lore.db`). It cannot live inside a Cloudflare Durable Object / Worker isolate. Phase 1 runs it inside the container. Phase 2 runs it as a separate always-on service; Flue points its model base URL at that gateway. `.lore.md` remains git-tracked in each target repo.

## Risks noted

- Flue 2.x on Cloudflare Agents SDK — pin `agents@^0.14.2` and validate durability APIs at build.
- Session data model changes from OpenCode `{sessions, messages, sessionStatus}` scrape → Flue conversation stream; dashboard adapters needed.
- Outpost's existing Vite dual-mode (client SPA + Worker) must compose with `flue()` + `cloudflare({ config: flueWorkerConfig() })`.
- **Sandbox id alignment**: prep, Flue conversation id, and Jared `useSandbox(getSandbox(...))` MUST share `toAgentInstanceId(entityKey)`.
- Default `FLUE_NATIVE=0` until Phase 2 is proven in a real Cloudflare deploy.
