# OpenCode Container for Cloudflare Containers
# Runs opencode serve headlessly to process GitHub webhook events.
# linux/amd64 only (Cloudflare Containers requirement).

FROM debian:bookworm-slim

ARG NODE_VERSION=22

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

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
      build-essential \
      fd-find \
      fzf \
      gh \
      git \
      jq \
      less \
      openssh-client \
      ripgrep \
      sudo \
      tini \
      unzip \
      vim-tiny \
      wget \
      xz-utils \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd \
 && rm -rf /var/lib/apt/lists/*

# --- Node.js via nodesource ---
RUN curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && npm install -g corepack@latest \
 && corepack enable \
 && corepack prepare pnpm@latest --activate \
 && rm -rf /var/lib/apt/lists/*

# --- Sentry CLI ---
RUN curl -fsSL https://cli.sentry.dev/install \
    | SENTRY_INSTALL_DIR=/usr/local/bin \
      bash -s -- --no-modify-path --no-completions

# --- Non-root user ---
RUN groupadd --gid 1000 developer \
 && useradd --uid 1000 --gid 1000 \
      --create-home --shell /bin/bash developer \
 && echo 'developer ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/developer \
 && chmod 0440 /etc/sudoers.d/developer \
 && install -d -m 0755 -o developer -g developer \
      /home/developer/dev \
      /home/developer/.opencode \
      /home/developer/.local \
      /home/developer/.local/share \
      /home/developer/.config \
      /home/developer/.config/opencode

USER developer

# --- Bun + OpenCode ---
RUN curl -fsSL https://bun.sh/install | bash \
 && curl -fsSL https://opencode.ai/install | bash

ENV PATH="/home/developer/.bun/bin:/home/developer/.opencode/bin:$PATH"

# --- Jared agent + skills ---
COPY --chown=developer:developer agents/ /home/developer/.config/opencode/agents/
COPY --chown=developer:developer skills/ /home/developer/.config/opencode/skills/

# --- Setup/shutdown scripts ---
COPY --chown=developer:developer scripts/ /opt/scripts/

# --- Entrypoint ---
COPY --chmod=0755 entrypoint.sh /usr/local/bin/entrypoint.sh

EXPOSE 4096
WORKDIR /home/developer/dev

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"]
