/**
 * D#6 R7c: which variables of a repo's Nix dev shell reach a job, and in what shape. A closed allowlist: PATH-like variables and a short list of tool
 * variables, nothing else. `shellHook`, `SHELL`, every `NIX_*` name, `LD_*` and the stdenv build variables are never carried. Pure: no process, no file.
 * `cleanEnv` (the one environment builder) and the daemon's Nix step both use this file, so the list cannot drift between them.
 */

/** Variables whose value is a `:`-separated list of directories. Every entry kept must be a Nix store path. */
export const NIX_PATH_VARS: readonly string[] = Object.freeze(["PATH", "PKG_CONFIG_PATH", "CPATH", "C_INCLUDE_PATH", "CPLUS_INCLUDE_PATH", "LIBRARY_PATH", "NODE_PATH", "PYTHONPATH"]);

/** Variables that name one tool or one install: a bare command name or a Nix store path. */
export const NIX_TOOL_VARS: readonly string[] = Object.freeze(["CC", "CXX", "AR", "AS", "LD", "NM", "RANLIB", "STRIP", "OBJCOPY", "OBJDUMP", "READELF", "SIZE", "STRINGS", "JAVA_HOME", "GOROOT", "PLAYWRIGHT_BROWSERS_PATH"]);

export const NIX_ENV_NAMES: readonly string[] = Object.freeze([...NIX_PATH_VARS, ...NIX_TOOL_VARS]);

/** The only directory a dev shell's entries may sit in, and the one read the job is granted for them. */
export const NIX_STORE = "/nix/store";

/** Tool variables that name a directory: a bare command name makes no sense for them, so only a Nix store path is kept. */
const STORE_ONLY_VARS: readonly string[] = Object.freeze(["PLAYWRIGHT_BROWSERS_PATH"]);

const STORE_ENTRY = /^\/nix\/store\/[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)*$/;
const TOOL_NAME = /^[A-Za-z0-9_+.-]{1,64}$/;
const MAX_VALUE = 32 * 1024;

/** True for a path entry that is under the store with no `..` segment and no odd character. */
export function isStoreEntry(entry: string): boolean {
  return STORE_ENTRY.test(entry) && !entry.split("/").some((part) => part === "..");
}

/** The value as a job may hold it, or undefined: path-like variables keep only their store entries; tool variables must be a command name or a store path. */
export function nixEnvValue(name: string, value: unknown): string | undefined {
  if (typeof value !== "string" || value === "" || value.length > MAX_VALUE || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  if (NIX_PATH_VARS.includes(name)) {
    const kept = value.split(":").filter(isStoreEntry);
    return kept.length === 0 ? undefined : [...new Set(kept)].join(":");
  }
  if (STORE_ONLY_VARS.includes(name)) return isStoreEntry(value) ? value : undefined;
  if (NIX_TOOL_VARS.includes(name)) return TOOL_NAME.test(value) || isStoreEntry(value) ? value : undefined;
  return undefined;
}

/**
 * The filtered environment of `nix print-dev-env --json` output. Only an `exported` variable counts. Looked up by allowlisted name, never
 * by walking the dev shell's own names, so a variable that is not on the list cannot get through however it is named.
 */
export function filterDevEnv(variables: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof variables !== "object" || variables === null || Array.isArray(variables)) return out;
  const table = variables as Record<string, unknown>;
  for (const name of NIX_ENV_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(table, name)) continue;
    const entry = table[name];
    if (typeof entry !== "object" || entry === null) continue;
    const { type, value } = entry as { type?: unknown; value?: unknown };
    if (type !== "exported") continue;
    const kept = nixEnvValue(name, value);
    if (kept !== undefined) out[name] = kept;
  }
  return out;
}
