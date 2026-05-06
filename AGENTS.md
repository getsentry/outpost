<!-- This section is maintained by the coding agent via lore (https://github.com/BYK/loreai) -->
## Long-term Knowledge

### Gotcha

<!-- lore:019dfed8-3063-715f-886b-2721a0e319b9 -->
* **Use `command = ["sh", "-c", init_script]` — NOT heredoc or printenv — for Coder agent in Kubernetes**: Heredoc in `args` breaks (Kubernetes JSON-serializes newlines to `\n`). Passing `init_script` as a K8s env var and using `printenv` also fails (unknown reason — likely interaction with the container ENTRYPOINT or network). The **only working pattern** matching the official Coder Kubernetes template is: `command = ["sh", "-c", coder_agent.main.init_script]` with `env { name = "CODER_AGENT_TOKEN" value = coder_agent.main.token }`. This overrides the Docker ENTRYPOINT (bypasses docker-entrypoint.sh), lets `sh` run the init_script directly, which downloads the correct server-version coder binary and runs `exec ./coder agent`. See [[019dfed8-3068-77f5-ba73-4c0ad108baea]].

<!-- lore:019dff65-568a-7669-a6f5-861ad24c024d -->
* **docker-entrypoint.sh set -e crashes container on gh/git identity errors**: With \`set -e\`, any failure in the \`gh auth setup-git\` or \`gh api user\` block (e.g. git running in a non-repo cwd, network errors) exits the entrypoint before \`exec "$@"\`, causing a crash-loop. Symptoms: only \`fatal: not in a git directory\` on stderr, no init script output, no coder agent startup. Fix: wrap the entire identity-setup block with \`set +e\` / \`set -e\` so these failures are logged as warnings instead of killing the container. The critical sections (volume chown, git init, final exec) keep \`set -e\`.

### Pattern

<!-- lore:019dfed8-3068-77f5-ba73-4c0ad108baea -->
* **Use coder\_script for OpenCode server, not container CMD/ENTRYPOINT**: Use `command = ["sh", "-c", coder_agent.main.init_script]` in the Kubernetes container spec (overrides Docker ENTRYPOINT entirely). The init_script downloads the server-version coder binary and sets `CODER_AGENT_URL` internally — no need to set it as a K8s env var. Only `CODER_AGENT_TOKEN` must be passed as a K8s env var. Start OpenCode via `coder_script` with `run_on_start = true` (runs after agent connects). The Coder provider bakes correct `ACCESS_URL` into `init_script` at apply time. See [[019dfed8-3063-715f-886b-2721a0e319b9]] for why heredoc and printenv approaches fail.
<!-- End lore-managed section -->
