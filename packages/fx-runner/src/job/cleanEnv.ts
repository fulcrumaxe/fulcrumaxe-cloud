/**
 * The environment the agent process starts with, built from a constant allowlist.
 *
 * Nothing here reads the host environment as a whole: no spread, no `Object.keys`, no loop (`test/cleanEnv.test.ts`
 * greps the source for that). Each allowed name is looked up by name, so a variable that is not on the list cannot
 * reach the agent, however it got into the host's environment.
 */

/** Host variables copied through when they are set. `HOME` is how the agent's binary finds the user's own login. */
export const HOST_ENV_ALLOWLIST: readonly string[] = Object.freeze(["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "TZ"]);

/** The one variable copied from the host in subscription mode only: the user's own subscription token. */
export const SUBSCRIPTION_TOKEN_VAR = "CLAUDE_CODE_OAUTH_TOKEN";

/**
 * Set on every run. The runner uses the user's own installed agent binary, so it does not set `DISABLE_UPDATES`: the
 * user's install keeps managing its updates, and the per-job version and flag checks catch a build that no longer fits.
 *  - `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` removes the API key, auth token and OAuth token from the environment of every
 *    tool subprocess, so a shell command the agent runs does not inherit the credential the CLI itself needs.
 */
export const FIXED_ENV: Readonly<Record<string, string>> = Object.freeze({ CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1" });

/**
 * How the run authenticates. Subscription mode has no field for an API key, so none can be passed. API-key mode takes
 * the key from the runner's own local config, never from the shell.
 */
export type CredentialMode = { mode: "subscription" } | { mode: "api_key"; apiKey: string };

/** Settings for the one part of the environment that is neither copied from the host nor fixed. */
export interface CleanEnvOptions {
  /**
   * Absolute directories added to the end of PATH when not already on it: where the shell sandbox's own tools
   * (bubblewrap, socat) were found at setup, which on NixOS is a store path the host PATH does not hold. Added at the
   * end, never the front, so a system directory cannot reorder the commands the agent already resolved. A relative
   * entry is refused.
   */
  extraPathDirs?: readonly string[];
}

/** `pathValue` with each of `dirs` added at the end unless it is already an entry. */
function withDirs(pathValue: string | undefined, dirs: readonly string[]): string | undefined {
  // POSIX only: the runner supports macOS, Linux and WSL2, where PATH entries are `:`-separated and absolute paths start with `/`.
  const entries = pathValue === undefined || pathValue === "" ? [] : pathValue.split(":");
  for (const dir of dirs) {
    if (typeof dir !== "string" || !dir.startsWith("/") || dir.includes(":") || dir.includes("\0")) throw new TypeError("cleanEnv: extraPathDirs must be absolute directories");
    if (!entries.includes(dir)) entries.push(dir);
  }
  return entries.length === 0 ? undefined : entries.join(":");
}

/** Builds the child environment. A name outside the allowlist, the fixed set and this mode's one credential is never copied. */
export function cleanEnv(credentials: CredentialMode, options: CleanEnvOptions = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of HOST_ENV_ALLOWLIST) {
    const value = process.env[name];
    if (typeof value === "string" && value !== "") env[name] = value;
  }
  const widened = withDirs(env.PATH, options.extraPathDirs ?? []);
  if (widened !== undefined) env.PATH = widened;
  Object.assign(env, FIXED_ENV);
  if (credentials.mode === "subscription") {
    const token = process.env[SUBSCRIPTION_TOKEN_VAR];
    if (typeof token === "string" && token !== "") env[SUBSCRIPTION_TOKEN_VAR] = token;
  } else if (credentials.mode === "api_key") {
    if (typeof credentials.apiKey !== "string" || credentials.apiKey === "") throw new TypeError("cleanEnv: api_key mode needs the key from local config");
    env.ANTHROPIC_API_KEY = credentials.apiKey;
  } else {
    throw new TypeError("cleanEnv: unknown credential mode");
  }
  return env;
}
