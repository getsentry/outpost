#!/usr/bin/env bun
// Container setup script — runs before OpenCode starts.
//
// 1. Fetches config from the Worker (repo, token, identity, session, LLM keys)
// 2. Writes environment variables to /tmp/opencode-env.sh (sourced by entrypoint)
// 3. Configures git identity and gh auth
// 4. Clones the target repository
// 5. Restores session history from D1

import { $ } from "bun";

const WORKER_URL = "http://worker.internal";
const ENTITY_KEY = process.env.ENTITY_KEY ?? "";
const DEV_DIR = `${process.env.HOME}/dev`;
const ENV_FILE = "/tmp/opencode-env.sh";

interface ContainerConfig {
	entityKey: string;
	repo: string;
	repoUrl: string;
	installationToken: string;
	botLogin: string;
	botEmail: string;
	sentryDsn: string;
	anthropicApiKey: string;
	openaiApiKey: string;
	sessionData: string | null;
}

async function fetchConfig(): Promise<ContainerConfig | null> {
	try {
		const url = `${WORKER_URL}/config?entity=${encodeURIComponent(ENTITY_KEY)}`;
		const response = await fetch(url);
		if (!response.ok) {
			console.error(`[setup] Config fetch failed: ${response.status}`);
			return null;
		}
		return (await response.json()) as ContainerConfig;
	} catch (err) {
		console.error("[setup] Could not reach worker:", err);
		return null;
	}
}

/**
 * Write environment variables to a file that the entrypoint sources
 * before starting OpenCode. This ensures all env vars propagate to
 * the OpenCode process (process.env changes in Bun don't propagate
 * to sibling processes started by the shell).
 */
async function writeEnvFile(config: ContainerConfig) {
	const lines: string[] = [];

	if (config.installationToken) {
		lines.push(`export GH_TOKEN="${config.installationToken}"`);
	}
	if (config.sentryDsn) {
		lines.push(`export SENTRY_DSN="${config.sentryDsn}"`);
	}
	if (config.anthropicApiKey) {
		lines.push(`export ANTHROPIC_API_KEY="${config.anthropicApiKey}"`);
	}
	if (config.openaiApiKey) {
		lines.push(`export OPENAI_API_KEY="${config.openaiApiKey}"`);
	}

	await Bun.write(ENV_FILE, `${lines.join("\n")}\n`);
	console.log(`[setup] Environment file written (${lines.length} vars)`);
}

async function configureGit(config: ContainerConfig) {
	if (config.botLogin) {
		await $`git config --global user.name ${config.botLogin}`.quiet();
		console.log(`[setup] Git user.name: ${config.botLogin}`);
	}

	if (config.botEmail) {
		await $`git config --global user.email ${config.botEmail}`.quiet();
		console.log(`[setup] Git user.email: ${config.botEmail}`);
	}

	if (config.installationToken) {
		// Configure gh CLI auth
		const proc = Bun.spawn(["gh", "auth", "login", "--with-token"], {
			stdin: new TextEncoder().encode(config.installationToken),
			stdout: "ignore",
			stderr: "ignore",
		});
		await proc.exited;

		await $`gh auth setup-git`.quiet().nothrow();
		console.log("[setup] GitHub auth configured");
	}
}

async function cloneRepo(config: ContainerConfig): Promise<string> {
	const repoDir = `${DEV_DIR}/repo`;

	if (config.repo && config.installationToken) {
		const cloneUrl = `https://x-access-token:${config.installationToken}@github.com/${config.repo}.git`;
		console.log(`[setup] Cloning ${config.repo}...`);

		const result =
			await $`git clone --depth 50 ${cloneUrl} ${repoDir}`.nothrow().quiet();

		if (result.exitCode === 0) {
			console.log(`[setup] Cloned to ${repoDir}`);
			return repoDir;
		}
		console.error("[setup] Clone failed, falling back to dev dir");
	}

	// Ensure dev dir has a git repo so OpenCode has a worktree
	await $`git init -q ${DEV_DIR}`.nothrow().quiet();
	return DEV_DIR;
}

async function restoreSession(config: ContainerConfig) {
	if (!config.sessionData) return;

	console.log("[setup] Restoring session history...");
	const tmpFile = "/tmp/session-import.json";

	await Bun.write(tmpFile, config.sessionData);
	const result = await $`opencode import ${tmpFile}`.nothrow().quiet();

	if (result.exitCode === 0) {
		console.log("[setup] Session restored");
	} else {
		console.error("[setup] Session import failed");
	}

	await $`rm -f ${tmpFile}`.quiet();
}

// --- Main ---

async function main() {
	console.log(`[setup] Starting setup for entity: ${ENTITY_KEY}`);

	const config = await fetchConfig();
	if (!config) {
		console.log("[setup] No config available, starting with defaults");
		process.chdir(DEV_DIR);
		return;
	}

	await writeEnvFile(config);
	await configureGit(config);
	const workDir = await cloneRepo(config);
	process.chdir(workDir);
	await restoreSession(config);

	console.log("[setup] Ready.");
}

await main();
