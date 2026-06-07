#!/bin/sh
# OpenCode container entrypoint.
#
# Delegates setup and shutdown logic to TypeScript scripts executed
# via Bun for easier maintenance. The shell only handles process
# lifecycle (signal trapping + forwarding).
set -e

SCRIPTS_DIR="/opt/scripts"

# --- Setup: fetch config, clone repo, configure git, restore session ---
bun run "$SCRIPTS_DIR/setup.ts"

# --- Source environment variables written by setup.ts ---
# The setup script writes env vars (API keys, tokens) to this file
# because process.env changes in Bun don't propagate to the shell.
[ -f /tmp/opencode-env.sh ] && . /tmp/opencode-env.sh

# --- SIGTERM handler ---
# On shutdown: export session to D1, then forward signal to OpenCode.
OPENCODE_PID=""

handle_signal() {
  echo "[entrypoint] Received shutdown signal"
  bun run "$SCRIPTS_DIR/shutdown.ts" || true
  if [ -n "$OPENCODE_PID" ]; then
    kill -TERM "$OPENCODE_PID" 2>/dev/null || true
    wait "$OPENCODE_PID" 2>/dev/null || true
  fi
  exit 0
}

trap handle_signal TERM INT

# --- Start OpenCode in the background ---
echo "[entrypoint] Starting OpenCode..."
"$@" &
OPENCODE_PID=$!

# Wait for the background process. If a signal arrives, the trap fires.
wait "$OPENCODE_PID"
EXIT_CODE=$?

echo "[entrypoint] OpenCode exited with code ${EXIT_CODE}"
exit "$EXIT_CODE"
