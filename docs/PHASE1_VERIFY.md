# Phase 1 verification checklist

End-to-end checks for the in-container Flue harness (`FLUE_NATIVE=0` +
`container/Dockerfile.phase1`).

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
2. Point `containers[].image` at `Dockerfile.phase1` (or build that tag).
3. Label a test issue with `jared`.
4. Confirm `/tmp/flue.log` grows, Lore gateway is on `:3207`, and
   `POST /api/containers/sessions` receives reporter payloads.
5. Confirm a draft PR opens (or `SKIPPED:` / `BLOCKED:` is recorded).

## Phase 2 switch

Set `FLUE_NATIVE=1` (default) and use the thin `Dockerfile`. Agent brain
runs as `FlueJaredAgent` DO; container has no Flue/Lore process. See
`docs/LORE_GATEWAY.md` for the standalone Lore service.
