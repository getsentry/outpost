#!/bin/sh
# Sandbox container entrypoint. Simplified version of docker-entrypoint.sh
# for ephemeral per-entity containers managed by Cloudflare Containers.
set -e

DEV_DIR="${HOME:-/home/developer}/dev"

# Ensure working directories exist.
mkdir -p "$DEV_DIR/.opencode"

# Initialize a git repo in ~/dev so OpenCode can anchor its worktree.
if [ ! -d "$DEV_DIR/.git" ]; then
  git init -q "$DEV_DIR"
fi

# --- Identity setup (fail-soft) ---
set +e

# GH_TOKEN is injected by the Worker via container envVars.
if [ -n "$GH_TOKEN" ]; then
  gh auth setup-git 2>/dev/null \
    || echo "WARN: gh auth setup-git failed" >&2
fi

# Clone the repo if REPO_URL is set and the directory doesn't exist yet.
if [ -n "$REPO_URL" ] && [ -n "$ENTITY_KEY" ]; then
  # Extract owner/repo from entity key (format: owner/repo#N).
  REPO_SLUG=$(echo "$ENTITY_KEY" | sed 's/#.*//')
  REPO_DIR="$DEV_DIR/$REPO_SLUG"

  if [ ! -d "$REPO_DIR" ]; then
    mkdir -p "$(dirname "$REPO_DIR")"
    git clone --depth 1 "$REPO_URL" "$REPO_DIR" 2>/dev/null \
      || echo "WARN: git clone failed for $REPO_URL" >&2
  fi
fi

# Set git identity from GH_TOKEN if available.
if [ -n "$GH_TOKEN" ]; then
  GH_USER_JSON=$(gh api user 2>/dev/null) || GH_USER_JSON=""
  if [ -n "$GH_USER_JSON" ]; then
    GH_LOGIN=$(printf '%s' "$GH_USER_JSON" | jq -r '.login // empty')
    GH_ID=$(printf '%s' "$GH_USER_JSON" | jq -r '.id // empty')
    GH_NAME=$(printf '%s' "$GH_USER_JSON" | jq -r '.name // .login // empty')
    if [ -n "$GH_LOGIN" ] && [ -n "$GH_ID" ]; then
      GH_EMAIL="${GH_ID}+${GH_LOGIN}@users.noreply.github.com"
      git config --global user.name "$GH_NAME"
      git config --global user.email "$GH_EMAIL"
    fi
  fi
fi

# Fallback identity.
if ! git config --global --get user.email >/dev/null 2>&1; then
  git config --global user.email "sandbox@outpost.local"
  git config --global user.name "Sandbox"
fi

set -e

cd "$DEV_DIR"
exec "$@"
