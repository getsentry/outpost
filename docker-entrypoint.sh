#!/bin/sh
# Abort on unhandled errors only for critical setup (volume, git init).
# The gh/git identity block is fail-soft — errors there must not prevent
# the container from reaching exec "$@" (which starts the Coder agent).
set -e

DEV_DIR="${HOME:-/home/developer}/dev"

# A fresh Railway Volume mounted at ~/dev lands owned by root, so fix it
# up to belong to the running user before we try to write to it.
# Passwordless sudo is configured for the developer user specifically
# so this single chown can succeed without further setup.
if [ ! -w "$DEV_DIR" ]; then
  sudo chown "$(id -u):$(id -g)" "$DEV_DIR" || {
    echo "ERROR: $DEV_DIR is not writable and chown failed." >&2
    echo "Check the volume's mount permissions in your platform's dashboard." >&2
    exit 1
  }
fi

# Ensure OpenCode's session/auth dir exists in the dev volume. The image
# symlinks ~/.local/share/opencode -> ~/dev/.opencode so a single Railway
# Volume mounted at ~/dev persists projects + session history together.
mkdir -p "$DEV_DIR/.opencode"

# OpenCode picks the "worktree" (project root) by walking up from cwd
# looking for a .git directory. With no .git ancestor it falls back to /
# and refuses to write there ("the default working directory (/) doesn't
# allow writing"). Init ~/dev as a git repo so opencode anchors there as
# the worktree. Skipped if a previous deploy already set this up.
if [ ! -d "$DEV_DIR/.git" ]; then
  git init -q "$DEV_DIR"
fi

# --- Identity setup (fail-soft) -------------------------------------------
# Everything below is best-effort: identity configuration must never
# prevent the container from starting. Disable set -e for this section so
# unexpected failures are logged as warnings instead of crashing the
# container into a restart loop.
set +e

# If GH_TOKEN is set (either from a PAT or injected by the bootstrap
# process from a GitHub App installation token), configure git's
# credential helper so `git push` / `git clone` over HTTPS work.
if [ -n "$GH_TOKEN" ]; then
  gh auth setup-git 2>/dev/null \
    || echo "WARN: gh auth setup-git failed; agents that run 'git push' over HTTPS may stall" >&2
fi

# Set git author identity. When a GitHub App is configured, the
# bootstrap process (bootstrap.ts) handles identity setup from the
# App's bot account. When only GH_TOKEN (PAT) is available, resolve
# the identity from it.
if [ -n "$GH_TOKEN" ] && [ -z "$GITHUB_APP_ID" ]; then
  GH_USER_JSON=$(gh api user 2>/dev/null) || GH_USER_JSON=""
  if [ -n "$GH_USER_JSON" ]; then
    GH_LOGIN=$(printf '%s' "$GH_USER_JSON" | jq -r '.login // empty')
    GH_ID=$(printf '%s' "$GH_USER_JSON" | jq -r '.id // empty')
    GH_NAME=$(printf '%s' "$GH_USER_JSON" | jq -r '.name // .login // empty')
    if [ -n "$GH_LOGIN" ] && [ -n "$GH_ID" ]; then
      GH_EMAIL="${GH_ID}+${GH_LOGIN}@users.noreply.github.com"
      git config --global user.name  "$GH_NAME"
      git config --global user.email "$GH_EMAIL"
      git -C "$DEV_DIR" config user.name  "$GH_NAME"
      git -C "$DEV_DIR" config user.email "$GH_EMAIL"
      echo "git author identity (PAT): $GH_NAME <$GH_EMAIL>"
    fi
  fi
fi

# Fallback identity when no identity is configured yet.
if ! git -C "$DEV_DIR" config --get user.email >/dev/null 2>&1; then
  git -C "$DEV_DIR" config user.email "developer@outpost.local"
  git -C "$DEV_DIR" config user.name  "Developer"
fi

# --- End identity setup ---------------------------------------------------
# Re-enable strict errors for the final exec.
set -e

# Pin cwd to ~/dev — Railway can start the container from / regardless
# of the Dockerfile's WORKDIR.
cd "$DEV_DIR"

exec "$@"
