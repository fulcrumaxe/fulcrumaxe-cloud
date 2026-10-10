/**
 * The environment the agent process starts with, built from a constant allowlist.
 *
 * Nothing here reads the host environment as a whole: no spread, no `Object.keys`, no loop (`test/cleanEnv.test.ts`
 * greps the source for that). Each allowed name is looked up by name, so a variable that is not on the list cannot
 * reach the agent, however it got into the host's environment.
 */
import { NIX_ENV_NAMES, nixEnvValue } from "./nixShellEnv.js";

/** Host variables copied through when they are set. `HOME` is how the agent's binary finds the user's own login. */
export const HOST_ENV_ALLOWLIST: readonly string[] = Object.freeze(["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "TZ"]);

/**
 * Marker variables a login shell reads to decide whether the system has already set the user's environment (D#6 R4d-3). The agent
 * CLI starts its Bash tool through a login shell, and on NixOS `/etc/profile` replaces PATH wholesale unless this marker is set, which would drop
 * the toolchain directories `extraPathDirs` adds and leave only the user-profile ones under the home directory the sandbox hides. When the
 * host's own environment already carries the marker, it is copied through, so that shell keeps the PATH the runner built. Only this value `1`
 * is copied, by name, and only when set.
 */
export const LOGIN_SHELL_MARKERS: readonly string[] = Object.freeze(["__NIXOS_SET_ENVIRONMENT_DONE"]);

/** The one variable copied from the host in subscription mode only: the user's own subscription token. */
export const SUBSCRIPTION_TOKEN_VAR = "CLAUDE_CODE_OAUTH_TOKEN";

/**
 * Set on every run. The runner uses the user's own installed agent binary, so it does not set `DISABLE_UPDATES`: the
 * user's install keeps managing its updates, and the per-job version and flag checks catch a build that no longer fits.
 *  - `FX_RUNNER_JOB` marks a process running inside a runner job. The runner's own real-Nix and real-bubblewrap suites read it and skip: inside a job
 *    bubblewrap can create namespaces but the nested view fails (D#6 R7e). It is set here, so a host value cannot clear it.
 *  - `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` removes the API key, auth token and OAuth token from the environment of every
 *    tool subprocess, so a shell command the agent runs does not inherit the credential the CLI itself needs.
 */
export const FIXED_ENV: Readonly<Record<string, string>> = Object.freeze({ CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1", FX_RUNNER_JOB: "1" });

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
  /**
   * D#6 R7b: the per-job additions of a job that carries sandbox allowances, only by the names in `JOB_ENV_NAMES` (the per-job cache directory,
   * the repo's package store, the Bash tool's timeouts). Any other name, or a value with a control character, is refused, so this can never
   * carry a credential or a path to one. Looked up by name like the rest.
   */
  jobEnv?: Readonly<Record<string, string>>;
}

/** The only names a job's own environment may set. A repo's Nix dev shell (D#6 R7c) adds only the names in `NIX_ENV_NAMES`, each value checked again. */
export const JOB_ENV_NAMES: readonly string[] = Object.freeze(["TMPDIR", "CLAUDE_ENV_FILE", "XDG_CACHE_HOME", "pnpm_config_store_dir", "pnpm_config_verify_store_integrity", "BASH_DEFAULT_TIMEOUT_MS", "BASH_MAX_TIMEOUT_MS"]);

/** True for a PATH entry that is an absolute directory with no NUL byte. */
function isAbsoluteEntry(entry: string): boolean {
  return entry.startsWith("/") && !entry.includes("\0");
}

/** `pathValue` with each of `dirs` added at the end unless it is already an entry. */
function withDirs(pathValue: string | undefined, dirs: readonly string[]): string | undefined {
  // POSIX only: the runner supports macOS and Linux, where PATH entries are `:`-separated and absolute paths start with `/`.
  // Only absolute host entries are kept. An empty or relative entry (`::`, `.`, `bin`) resolves against the working
  // directory, which is the workspace, so a tool the agent wrote there (a `bwrap`, say) would run outside the sandbox.
  const entries = pathValue === undefined || pathValue === "" ? [] : pathValue.split(":").filter(isAbsoluteEntry);
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
  for (const name of LOGIN_SHELL_MARKERS) if (process.env[name] === "1") env[name] = "1";
  const widened = withDirs(env.PATH, options.extraPathDirs ?? []);
  if (widened !== undefined) env.PATH = widened;
  else delete env.PATH;
  Object.assign(env, FIXED_ENV);
  if (options.jobEnv !== undefined) {
    const given = options.jobEnv;
    for (const name of Object.getOwnPropertyNames(given)) if (!JOB_ENV_NAMES.includes(name) && !NIX_ENV_NAMES.includes(name)) throw new TypeError("cleanEnv: not an allowed per-job variable");
    // The dev shell's tools: store paths only. PATH entries go after the host's own (never in front of them); the other names are set as given.
    for (const name of NIX_ENV_NAMES) {
      const value = given[name];
      if (value === undefined) continue;
      const checked = nixEnvValue(name, value);
      if (checked === undefined || checked !== value) throw new TypeError("cleanEnv: bad dev shell variable value");
      env[name] = name === "PATH" ? [...new Set([...(env.PATH === undefined ? [] : env.PATH.split(":")), ...checked.split(":")])].join(":") : checked;
    }
    for (const name of JOB_ENV_NAMES) {
      const value = given[name];
      if (value === undefined) continue;
      if (typeof value !== "string" || value === "" || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError("cleanEnv: bad per-job variable value");
      env[name] = value;
    }
  }
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

/**
 * What the runner's own git commands start with. The same shape as the agent's environment, minus every credential the
 * agent holds, plus the two names git needs to find the user's own setup: `XDG_CONFIG_HOME` (where git looks for the user's
 * config, and with it their credential helper) and `SSH_AUTH_SOCK` (for an ssh remote). Looked up by name like the rest.
 */
export const GIT_ENV_ALLOWLIST: readonly string[] = Object.freeze([...HOST_ENV_ALLOWLIST, "XDG_CONFIG_HOME", "SSH_AUTH_SOCK"]);

/** Set on every git command: a helper that would ask on a terminal fails instead of waiting for someone who is not there. */
export const GIT_FIXED_ENV: Readonly<Record<string, string>> = Object.freeze({ GIT_TERMINAL_PROMPT: "0" });

/** Builds the environment for a git command. Never holds the subscription token or the API key. */
export function gitEnv(options: CleanEnvOptions = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of GIT_ENV_ALLOWLIST) {
    const value = process.env[name];
    if (typeof value === "string" && value !== "") env[name] = value;
  }
  const widened = withDirs(env.PATH, options.extraPathDirs ?? []);
  if (widened !== undefined) env.PATH = widened;
  else delete env.PATH;
  Object.assign(env, GIT_FIXED_ENV);
  return env;
}

/**
 * Host variables the dependency install may see (D#6 C44-4): the language and terminal basics, and the names that point a program at the machine's CA
 * certificates (on NixOS the certificate store is only found through these). No home directory, no config location, no token, no proxy: `HOME` and
 * the temp and cache directories are the install's own scratch, set by the caller.
 */
export const INSTALL_ENV_ALLOWLIST: readonly string[] = Object.freeze(["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"]);

/**
 * The environment a host-side dependency install starts from, built from scratch: the allowlist above, the tool directories at the end of PATH, and the
 * settings in `fixed` (the caller's pins and scratch directories). Never holds the subscription token, an API key, a git token or any connection secret.
 */
export function installEnv(options: CleanEnvOptions, fixed: Readonly<Record<string, string>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INSTALL_ENV_ALLOWLIST) {
    const value = process.env[name];
    if (typeof value === "string" && value !== "") env[name] = value;
  }
  const widened = withDirs(env.PATH, options.extraPathDirs ?? []);
  if (widened !== undefined) env.PATH = widened;
  else delete env.PATH;
  Object.assign(env, fixed);
  return env;
}
