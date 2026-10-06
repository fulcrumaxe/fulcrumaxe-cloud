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
 * Set on every run. Both names are read by the pinned build (checked in 2.1.273):
 *  - `DISABLE_UPDATES` refuses all update paths;
 *  - `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` removes the API key, auth token and OAuth token from the environment of every
 *    tool subprocess, so a shell command the agent runs does not inherit the credential the CLI itself needs.
 */
export const FIXED_ENV: Readonly<Record<string, string>> = Object.freeze({ DISABLE_UPDATES: "1", CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1" });

/**
 * How the run authenticates. Subscription mode has no field for an API key, so none can be passed. API-key mode takes
 * the key from the runner's own local config, never from the shell.
 */
export type CredentialMode = { mode: "subscription" } | { mode: "api_key"; apiKey: string };

/** Builds the child environment. A name outside the allowlist, the fixed set and this mode's one credential is never copied. */
export function cleanEnv(credentials: CredentialMode): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of HOST_ENV_ALLOWLIST) {
    const value = process.env[name];
    if (typeof value === "string" && value !== "") env[name] = value;
  }
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
