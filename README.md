# Outpost

AI coding agent infrastructure for Sentry. Outpost connects GitHub issues to an autonomous coding agent ([Flue](https://flueframework.com), powered by [Pi](https://pi.dev)) running on Cloudflare Workers + Containers, with a dashboard to monitor sessions in real time.

## How it works

1. **Label a GitHub issue** with `jared` — a webhook fires to the Outpost Worker
2. **A Flue Durable Object** admits the prompt; a thin Sandbox container provides git/gh/node
3. **The agent analyzes the issue**, explores the codebase, implements a fix, runs tests, and opens a draft PR
4. **Monitor progress** in the Outpost dashboard — see live sessions, messages, tool calls, and cost

When the agent creates a PR that references the issue (e.g. "Fixes #123"), subsequent PR events (reviews, CI results) are routed to the **same conversation**, preserving full context.

## Architecture

```
GitHub Webhook → Cloudflare Worker (Hono + Flue)
                      ├─ Flue Jared Durable Object  (agent brain + session + cron)
                      │        └─ Cloudflare Sandbox container (git / gh / node)
                      ├─ D1 (webhook events + dashboard session mirror)
                      └─ Lore gateway (standalone) ← model traffic
```

- **Worker**: Hono app on Cloudflare Workers — webhooks, dashboard, Flue agent routes
- **Flue agent**: Durable Object with tiered subagents (`explore`, `implement`, `ship`), skills, and native schedules
- **Container**: Thin Cloudflare Sandbox — Linux workspace only (no harness process)
- **Lore**: Standalone LLM memory gateway — see [docs/LORE_GATEWAY.md](docs/LORE_GATEWAY.md)
- **Dashboard**: React SPA with session sidebar, chat-style message viewer, and container management

`FLUE_NATIVE=1` (default in `wrangler.jsonc`) enables Phase 2. Set `FLUE_NATIVE=0` and build `container/Dockerfile.phase1` to run Flue in-container (Phase 1 rollback path).

## Project structure

```
apps/
  server/                   # Cloudflare Worker + React dashboard
    src/
      agents/               # Flue agents: jared (4.8) + explore/implement/ship
      cloudflare.ts         # Sandbox export + cron scheduled handler
      app.ts                # Hono + Flue createAgentRouter mount
      routes/               # webhooks, containers, events, …
      lib/containers/       # sandbox setup, Flue dispatch, session persistence
      client/               # React SPA
    container/
      Dockerfile            # Thin sandbox image (Phase 2)
      Dockerfile.phase1     # In-container Flue + Lore (Phase 1)
      flue/                 # Phase 1 Node Flue app source
      .agents/skills/       # Workspace skills discovered by Flue
packages/
  utils/
  validations/
docs/
  FLUE_PARITY.md            # Phase 0 spike findings
  LORE_GATEWAY.md           # Standalone Lore deploy notes
```

## Setup

### Prerequisites

- [Node.js](https://nodejs.org) 22+
- [pnpm](https://pnpm.io) 10+
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) (Cloudflare Workers CLI)
- A GitHub App configured with webhook permissions
- OpenRouter / Anthropic / OpenAI API keys
- (Phase 2) A standalone [Lore](https://github.com/BYK/loreai) gateway — see `docs/LORE_GATEWAY.md`

### Local development

```bash
# Install dependencies
pnpm install

# Set up environment variables
cp apps/server/.env.example apps/server/.dev.vars
# Edit .dev.vars with your API keys and GitHub App credentials

# Run D1 migrations
pnpm -F @jared/server db:migrate:dev

# Start dev server
pnpm dev
```

The dashboard will be available at `http://localhost:5173`.

### Deploy

```bash
pnpm deploy
```

## Dashboard

- **Containers page** — agent containers with session count, message count, cost, and status
- **Container detail** — session sidebar + chat-style message viewer
- **Webhook events** — incoming GitHub webhooks with status tracking
- **Container management** — destroy containers, clear sessions, execute commands

## Migration notes

See [docs/FLUE_PARITY.md](docs/FLUE_PARITY.md) for the OpenCode → Flue capability matrix and topology.
