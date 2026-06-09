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

# --- OpenCode CLI ---
ENV PATH="/root/.opencode/bin:${PATH}"
RUN curl -fsSL https://opencode.ai/install -o /tmp/install-opencode.sh \
 && bash /tmp/install-opencode.sh \
 && rm /tmp/install-opencode.sh \
 && opencode --version

# --- Workspace directory ---
RUN mkdir -p /workspace/repo

# --- Jared agent + skills ---
COPY agents/ /root/.config/opencode/agents/
COPY skills/ /root/.config/opencode/skills/

EXPOSE 4096
