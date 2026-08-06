# Thin Cloudflare Sandbox image for Outpost (Phase 2).
#
# The Flue agent brain runs as a Durable Object in the Worker. This container
# is only a Linux workspace: git, gh, sentry CLI, node, ripgrep, and workspace
# skills. No OpenCode / Flue / Lore process runs here.
#
# IMPORTANT: skills/AGENTS.md are baked under /root/.agents — NEVER under
# /workspace/repo. The Worker clones the target repo into /workspace/repo and
# then copies skills in via ensureWorkspaceSkills().
#
# For the Phase 1 in-container Flue harness image, see Dockerfile.phase1.
# linux/amd64 only (Cloudflare Containers requirement).
#
# IMPORTANT: this tag MUST match the @cloudflare/sandbox SDK version the Worker
# runs (see apps/server/package.json). A client/server protocol mismatch makes
# every sandbox.exec() hang.

FROM docker.io/cloudflare/sandbox:0.12.0

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

# --- Sentry CLI ---
# Used for issue/trace debugging inside the sandbox. Auth is injected at runtime
# via SENTRY_AUTH_TOKEN in /tmp/flue-env.sh (see writeEnvFile).
#
# Pin the version so the installer skips its `releases/latest` GitHub API lookup.
# That call gets rate-limited (HTTP 403) from shared CI/build egress IPs, which
# breaks the Cloudflare image build. Bump this to take a newer CLI.
ARG SENTRY_CLI_VERSION=0.41.0
RUN curl -fsSL https://cli.sentry.dev/install \
    | SENTRY_INSTALL_DIR=/usr/local/bin \
      bash -s -- --no-modify-path --no-completions --version "${SENTRY_CLI_VERSION}" \
 && sentry --version

# Empty parent for the Worker-managed clone target. Do not create
# /workspace/repo itself — `mv repo-tmp /workspace/repo` nests if dest exists.
RUN mkdir -p /workspace

# Skills live outside the clone target so git clone never fails on a nonempty dir.
COPY .agents/skills/ /root/.agents/skills/
COPY AGENTS.md /root/AGENTS.md

# Keep the base image's working dir so the sandbox control server (the base
# ENTRYPOINT the Worker's SDK talks to on port 3000) resolves its bundled
# executors. The Worker always passes an explicit cwd to exec()/startProcess().
WORKDIR /container-server
# No harness process — the Worker attaches this sandbox via cloudflareSandbox().
