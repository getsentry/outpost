# Outpost

AI coding agent infrastructure for Sentry. Outpost connects GitHub issues to an autonomous coding agent ([OpenCode](https://opencode.ai)) running inside Cloudflare Containers, with a dashboard to monitor sessions in real time.

## How it works

1. **Label a GitHub issue** with `jared` — a webhook fires to the Outpost Worker
2. **A container spins up** with OpenCode, clones the repo, and starts working on the issue
3. **The agent analyzes the issue**, explores the codebase, implements a fix, runs tests, and opens a draft PR
4. **Monitor progress** in the Outpost dashboard — see live sessions, messages, tool calls, and cost

When the agent creates a PR that references the issue (e.g. "Fixes #123"), subsequent PR events (reviews, CI results) are routed to the **same container and session**, preserving full context.

## Architecture

```
GitHub Webhook → Cloudflare Worker → Cloudflare Container (Sandbox)
                      ↓                      ↓
                   D1 (SQLite)          OpenCode + Agent
                      ↓                      ↓
                 Dashboard UI          GitHub API (PRs, reviews)
```

- **Worker**: Hono app on Cloudflare Workers — handles webhooks, serves the dashboard, manages containers
- **Container**: Cloudflare Sandbox running OpenCode with the Jared agent and custom skills
- **Database**: Cloudflare D1 (SQLite) — stores webhook events and agent session data
- **Dashboard**: React SPA with session sidebar, chat-style message viewer, and container management

## Project structure

```
apps/
  server/                   # Cloudflare Worker + React dashboard
    src/
      routes/
        webhooks/           # Webhook handlers (GitHub, Sentry)
        containers/         # Container management API
        events/             # Webhook event listing
      lib/
        github/             # GitHub App auth, entity extraction, prompts
        containers/         # Sandbox setup, dispatch, session persistence
      client/               # React SPA (pages, components, hooks)
    container/
      Dockerfile            # Container image (OpenCode + tools)
      agents/               # Agent definitions (jared.md)
      skills/               # Agent skills (resolve-issue, fix-ci, etc.)
packages/
  utils/                    # Shared utilities (logger, error formatting)
  validations/              # Shared Zod schemas
```

## Setup

### Prerequisites

- [Node.js](https://nodejs.org) 22+
- [pnpm](https://pnpm.io) 10+
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) (Cloudflare Workers CLI)
- A GitHub App configured with webhook permissions
- Anthropic API key for the AI agent

### Local development

```bash
# Install dependencies
pnpm install

# Set up environment variables
cp apps/server/.dev.vars.example apps/server/.dev.vars
# Edit .dev.vars with your API keys and GitHub App credentials

# Run D1 migrations
pnpm -F @jared/server db:migrate:dev

# Start dev server
pnpm dev
```

The dashboard will be available at `http://localhost:5173`.

### Deploy

```bash
# Deploy to Cloudflare Workers
pnpm deploy
```

This builds the Worker + client, pushes the container image, and deploys everything.

## Dashboard

The dashboard provides:

- **Containers page** — list of all agent containers with session count, message count, cost, and status
- **Container detail** — session sidebar + chat-style message viewer showing the full conversation
- **Webhook events** — all incoming GitHub webhooks with status tracking (pending → dispatched → completed)
- **Container management** — destroy containers, clear sessions, execute commands

## Webhook providers

| Provider | Status | Trigger |
|----------|--------|---------|
| GitHub   | Active | Label issue with `jared` |
| Sentry   | Planned | Assign issue to `jared` |

## Configuration

### GitHub App

The GitHub App needs the following permissions:
- **Repository**: Contents (read/write), Issues (read/write), Pull requests (read/write), Metadata (read)
- **Webhook events**: Issues, Issue comments, Pull requests, Pull request reviews, Check suites, Workflow runs

### Environment variables

| Variable | Description |
|----------|-------------|
| `GITHUB_APP_ID` | GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY` | GitHub App private key (PEM) |
| `GITHUB_APP_WEBHOOK_SECRET` | Webhook HMAC secret |
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude |
| `OPENAI_API_KEY` | OpenAI API key (optional, fallback) |
| `APP_URL` | Dashboard URL |
| `BETTER_AUTH_SECRET` | Auth session secret |
| `SENTRY_DSN` | Sentry error tracking DSN |

## License

Private — Sentry Enterprise
