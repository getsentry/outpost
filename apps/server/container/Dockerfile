# Thin Cloudflare Sandbox image for Outpost (Phase 2).
#
# The Flue agent brain runs as a Durable Object in the Worker. This container
# is only a Linux workspace: git, gh, node, ripgrep, and workspace skills.
# No OpenCode / Flue / Lore process runs here.
#
# IMPORTANT: skills/AGENTS.md are baked under /root/.agents — NEVER under
# /workspace/repo. The Worker clones the target repo into /workspace/repo and
# then copies skills in via ensureWorkspaceSkills().
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
# Keep pnpm pinned to the repo's packageManager version. pnpm 11 makes ignored
# dependency build scripts a hard install error, so `pnpm@latest` breaks the
# image build whenever upstream ships a new major.
ENV N_PREFIX=/usr/local
RUN npm install -g n \
 && n 22 \
 && hash -r \
 && corepack enable \
 && corepack prepare pnpm@10.15.0 --activate \
 && node --version && pnpm --version

# Empty parent for the Worker-managed clone target. Do not create
# /workspace/repo itself — `mv repo-tmp /workspace/repo` nests if dest exists.
RUN mkdir -p /workspace

# Skills live outside the clone target so git clone never fails on a nonempty dir.
COPY .agents/skills/ /root/.agents/skills/
COPY AGENTS.md /root/AGENTS.md

WORKDIR /workspace
# No harness process — the Worker attaches this sandbox via cloudflareSandbox().
