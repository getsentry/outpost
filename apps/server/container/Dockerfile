# Thin Cloudflare Sandbox image for Outpost (Phase 2).
#
# The Flue agent brain runs as a Durable Object in the Worker. This container
# is only a Linux workspace: git, gh, node, ripgrep, and workspace skills.
# No OpenCode / Flue / Lore process runs here.
#
# For the Phase 1 in-container Flue harness image, see Dockerfile.phase1.
# linux/amd64 only (Cloudflare Containers requirement).

FROM docker.io/cloudflare/sandbox:0.7.0

# --- System packages + GitHub CLI ---
RUN apt-get update \
 && install -d -m 0755 /etc/apt/keyrings \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      fd-find \
      fzf \
      gh \
      git \
      jq \
      ripgrep \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd \
 && rm -rf /var/lib/apt/lists/*

# --- Node.js 22 + pnpm ---
# Agent needs these to run typecheck, lint, and tests in target repos.
ENV N_PREFIX=/usr/local
RUN npm install -g n \
 && n 22 \
 && hash -r \
 && corepack enable \
 && corepack prepare pnpm@latest --activate \
 && node --version && pnpm --version

# --- Workspace ---
RUN mkdir -p /workspace/repo /.agents/skills /root/.agents/skills

# Flue discovers workspace skills at <cwd>/.agents/skills and AGENTS.md at cwd.
COPY .agents/skills/ /workspace/repo/.agents/skills/
COPY .agents/skills/ /root/.agents/skills/
COPY AGENTS.md /workspace/repo/AGENTS.md
COPY AGENTS.md /root/AGENTS.md

WORKDIR /workspace/repo
# No harness process — the Worker attaches this sandbox via cloudflareSandbox().
