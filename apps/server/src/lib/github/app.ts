// GitHub App authentication and Octokit client factory.
//
// Uses @octokit/auth-app for JWT generation and installation token
// management (with built-in caching). Provides helpers to create
// per-installation Octokit clients for API calls.

import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

export type GitHubAppConfig = {
	appId: string;
	privateKey: string;
	webhookSecret: string;
};

/**
 * Create a GitHub App auth strategy from Cloudflare Worker env bindings.
 * The returned auth function can generate JWTs and installation tokens.
 */
export function createGitHubApp(config: GitHubAppConfig) {
	// Normalize PEM key: env vars often store literal "\n" instead of newlines
	const privateKey = config.privateKey.replace(/\\n/g, "\n");

	const auth = createAppAuth({
		appId: config.appId,
		privateKey,
	});

	return {
		auth,
		webhookSecret: config.webhookSecret,

		/**
		 * Create an Octokit client authenticated as a specific installation.
		 * The token is automatically cached and refreshed by @octokit/auth-app.
		 */
		getInstallationOctokit(installationId: number): Octokit {
			return new Octokit({
				authStrategy: createAppAuth,
				auth: {
					appId: config.appId,
					privateKey,
					installationId,
				},
			});
		},

		/**
		 * Resolve the GitHub App's bot login (e.g. "my-app[bot]").
		 * Lazily fetches and caches the app slug.
		 */
		async getBotLogin(): Promise<string> {
			const appOctokit = new Octokit({
				authStrategy: createAppAuth,
				auth: {
					appId: config.appId,
					privateKey,
				},
			});
			const { data } = await appOctokit.apps.getAuthenticated();
			return `${data.slug}[bot]`;
		},
	};
}

export type GitHubApp = ReturnType<typeof createGitHubApp>;
