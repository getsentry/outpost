# Contributing to Outpost

## Development setup

1. Clone the repo and install dependencies:
   ```bash
   git clone https://github.com/getsentry/outpost.git
   cd outpost
   pnpm install
   ```

2. Copy the environment template and fill in your credentials:
   ```bash
   cp apps/server/.dev.vars.example apps/server/.dev.vars
   ```

3. Run D1 migrations locally:
   ```bash
   pnpm -F @jared/server db:migrate:dev
   ```

4. Start the dev server:
   ```bash
   pnpm dev
   ```

## Project layout

- `apps/server/` — the main Cloudflare Worker + React dashboard
- `apps/server/container/` — the Docker image for agent containers
- `apps/server/src/routes/` — API route handlers
- `apps/server/src/client/` — React SPA (dashboard UI)
- `apps/server/src/lib/` — shared business logic
- `packages/` — shared packages (utils, validations)

## Code style

- **TypeScript** — strict mode, no `any` unless necessary
- **Biome** — linting and formatting (`pnpm format`)
- **Imports** — use `@/` path alias for `apps/server/src/`

## Adding a new webhook provider

1. Create a new file in `apps/server/src/routes/webhooks/` (e.g. `gitlab.ts`)
2. Implement signature verification and payload parsing
3. Use `ensureSandboxReady()` and `dispatchPrompt()` from `@/lib/containers/dispatch` for container management
4. Mount the handler in `apps/server/src/routes/webhooks/index.ts`
5. Add any new environment variables to `apps/server/src/types/env/base.ts`

## Adding agent skills

Agent skills live in `apps/server/container/skills/`. Each skill is a directory with:
- `SKILL.md` — instructions the agent follows when the skill is loaded
- Optional supporting files

## Database

- **D1 (SQLite)** via Drizzle ORM
- Schema: `apps/server/src/db/schema.ts`
- Generate migrations: `pnpm -F @jared/server db:generate`
- Apply locally: `pnpm -F @jared/server db:migrate:dev`
- Apply production: `pnpm -F @jared/server db:migrate:prod`

## Deployment

```bash
pnpm deploy
```

This runs `turbo deploy` which builds the Worker, builds the client, pushes the container image, and deploys to Cloudflare.

## Key conventions

- Webhook handlers go in `src/routes/webhooks/<provider>.ts`
- Container/sandbox logic goes in `src/lib/containers/`
- Provider-specific logic (auth, API clients) goes in `src/lib/<provider>/`
- All container communication uses `sandbox.exec()` — there is no direct network path from the Worker to the container
- Session data syncs from the container to D1 when the dashboard detail page is accessed (auto-sync)
