# Phase 1 verification checklist

End-to-end checks for the in-container Flue harness (`FLUE_NATIVE=0` +
`container/Dockerfile.phase1`).

**Production default today:** Phase 1 (`FLUE_NATIVE=0` + `Dockerfile.phase1`).
Do not flip to Phase 2 until auth, Lore, and an end-to-end CF deploy are validated.

## Build

```bash
# Phase 1 Flue Node app
pnpm -F @jared/flue-container build
# → dist/server.mjs

# Container image (local)
docker build -f apps/server/container/Dockerfile.phase1 -t outpost-flue-phase1 apps/server/container
```

## Runtime smoke (inside container or local Node)

```bash
cd apps/server/container/flue
PORT=4096 node dist/server.mjs &
curl -sf http://localhost:4096/api/ping
# → {"ok":true,"harness":"flue","agent":"jared"}

curl -sf -X POST http://localhost:4096/agents/jared/smoke-1 \
  -H 'Content-Type: application/json' \
  -d '{"kind":"user","body":"Reply with PONG only."}'
# → 202 admission
```

## Worker dispatch path

1. Set `FLUE_NATIVE=0` in `.dev.vars` / wrangler vars.
2. Point `containers[].image` at `Dockerfile.phase1` (must match `FLUE_NATIVE=0`).
3. Label a test issue with `jared`.
4. Confirm `/tmp/flue.log` grows, Lore gateway is on `:3207` (or provider
   base URLs remain unset if Lore is unhealthy), and
   `POST /api/containers/sessions` receives reporter payloads with the
   internal token header.
5. Confirm a draft PR opens (or `SKIPPED:` / `BLOCKED:` is recorded).
6. Confirm `/tmp/flue-dispatch-*.ok` exists (or inspect `*.err` on failure).

## Phase 2 switch

**Not the default.** Set **both**:

1. `FLUE_NATIVE=1`
2. `containers[].image` → `./container/Dockerfile` (thin sandbox)

Agent brain runs as `FlueJaredAgent` DO; container has no Flue/Lore process.
Also set `LORE_GATEWAY_URL` to the standalone Lore service — see
`docs/LORE_GATEWAY.md`. Ensure `FLUE_INTERNAL_TOKEN` (or `BETTER_AUTH_SECRET`)
is set so history sync can authenticate against `/agents/jared`.

## Phase 1 limitations

- Per-conversation `scheduleFollowUp` / quiet-period auto-merge only exists on
  the Cloudflare DO extension — Phase 1 in-container Jared has no DO schedules.
