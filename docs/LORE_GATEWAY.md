# Standalone Lore Gateway (Phase 2)

Lore ([loreai](https://github.com/BYK/loreai)) is a transparent LLM proxy with a
local SQLite database. It **cannot** run inside a Cloudflare Durable Object or
Worker isolate. In Phase 2 the agent brain lives in a Flue DO, so Lore must be
deployed as a separate always-on service.

## Role

```
Flue Durable Object  --model HTTP-->  Lore Gateway  --upstream-->  OpenRouter / Anthropic / OpenAI
                                         |
                                         v
                                   lore.db (volume)
                                         |
                                         v
                              .lore.md (git-tracked in target repos)
```

## Suggested deploy

Use any container host with a persistent volume (Fly.io, Railway, a GCE VM, etc.):

```dockerfile
FROM node:22-bookworm-slim
RUN curl -fsSL https://withlore.ai/install | bash
ENV PORT=3207
VOLUME ["/root/.local/share/lore"]
EXPOSE 3207
CMD ["lore", "run", "--port", "3207"]
```

Mount a persistent volume at `~/.local/share/lore` so `lore.db` survives restarts.

## Wire into Outpost

Set the Worker secret / var:

```bash
wrangler secret put LORE_GATEWAY_URL
# value: https://lore.example.com
```

When `LORE_GATEWAY_URL` is set, `registerLoreOpenRouterProvider()` (called from
`app.ts`) re-registers the Flue `openrouter` provider so every
`openrouter/...` model call uses `${LORE_GATEWAY_URL}/v1` instead of
`api.openrouter.ai`. `OPENROUTER_API_KEY` is still required — Lore forwards it
upstream.

Also ensure Phase 2 uses the thin container image:

```jsonc
"vars": { "FLUE_NATIVE": "1" },
"containers": [{ "image": "./container/Dockerfile", ... }]
```

`.lore.md` continues to be committed in each target repository; Lore imports /
exports it as part of the team-memory workflow.

## Phase 1 vs Phase 2

| Phase | Where Lore runs | How models reach it |
| --- | --- | --- |
| 1 (`FLUE_NATIVE=0`, default) | `lore run` beside Flue in the Sandbox (`Dockerfile.phase1`) | After a health probe, sets `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL`; Flue Node also reads `LORE_GATEWAY_URL` |
| 2 (`FLUE_NATIVE=1`) | This standalone service | Worker `setProvider(openrouter → Lore /v1)` when `LORE_GATEWAY_URL` is set |
