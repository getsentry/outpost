/** Container-owned credential bootstrap; never source the provider-key env file. */
export const GITHUB_COMMAND_ENV = "/tmp/jared-github-env.sh"

type CommandOptions = { env?: Record<string, string | undefined>; sessionId?: string }

export function withGitHubCommandEnv<T extends CommandOptions>(options?: T) {
  if (options?.sessionId !== undefined) return options
  const env = { ...options?.env }
  // Explicit per-command credentials/startup hooks retain their SDK semantics.
  if (!Object.hasOwn(env, "GH_TOKEN") && !Object.hasOwn(env, "BASH_ENV")) env.BASH_ENV = GITHUB_COMMAND_ENV
  return { ...options, env }
}
