# OpenCode Container for Cloudflare Sandbox
# Uses the Cloudflare Sandbox base image. The Worker controls lifecycle
# via the Sandbox SDK (exec, startProcess, waitForPort).
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
# The sandbox base image has Node 20; we need 22 for pnpm and target repos.
ENV N_PREFIX=/usr/local
RUN npm install -g n \
 && n 22 \
 && hash -r \
 && corepack enable \
 && corepack prepare pnpm@latest --activate \
 && node --version && pnpm --version

# --- OpenCode CLI (pinned version) ---
# v1.17.4 has a bug where prompts are admitted but never processed in server mode.
# Pinning to v1.17.0 until this is fixed upstream.
ENV PATH="/root/.opencode/bin:${PATH}"
RUN curl -fsSL https://opencode.ai/install -o /tmp/install-opencode.sh \
 && bash /tmp/install-opencode.sh --version 1.17.0 \
 && rm /tmp/install-opencode.sh \
 && opencode --version

# --- Workspace directory ---
RUN mkdir -p /workspace/repo

# --- OpenCode config + Lore plugin ---
COPY opencode.json /root/.config/opencode/opencode.json

# --- Jared agent + skills ---
COPY agents/ /root/.config/opencode/agents/
COPY skills/ /root/.config/opencode/skills/

EXPOSE 4096
