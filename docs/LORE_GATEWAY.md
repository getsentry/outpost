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

`ensureSandboxReady` / Flue model config should point:

- `LORE_GATEWAY_URL` → gateway base
- `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` → gateway (OpenAI-compatible `/v1`)

`.lore.md` continues to be committed in each target repository; Lore imports /
exports it as part of the team-memory workflow.

## Phase 1 vs Phase 2

| Phase | Where Lore runs |
| --- | --- |
| 1 (in-container) | `lore run` started beside Flue inside the Sandbox (`Dockerfile.phase1`) |
| 2 (native DO) | This standalone service; container image has no Lore process |
