/**
 * D#6 R7b (correction C35 section 3.4, amending C15 sections 3 and 4): what the runner does with the sandbox allowances a signed job carries.
 *
 * The runner never trusts the cloud's own check. `allowanceRefusal` runs the protocol's one floor (`parseAllowanceSet`, which runs
 * `allowanceFloorViolation` on every entry). The daemon calls it before any process or directory exists, and the host sandbox calls it again
 * when the job launches. Whatever clears it is only ever turned into the four things the sandbox builder takes: extra read paths, extra write paths,
 * extra domains and the loopback bind. The runner's own per-repo package store and the per-job cache directory are not named by an entry; the
 * runner makes them, and `jobEnvFor` says where they are.
 */
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";
import { allowanceFloorViolation, parseAllowanceSet, type AllowanceEntry, type AllowanceRefusal } from "@fulcrumaxe/runner-protocol";

/** The allowances of one job as the port carries them: the signed entries, the timeout, and the plain word that names the repo's package store. */
export interface JobAllowanceGrant {
  entries: readonly AllowanceEntry[];
  commandTimeoutS: number;
  storeKey: string;
}

/** A path the runner cannot resolve with certainty (a link loop, a link that cannot be read, a chain that is too long). The caller refuses it. */
export class UnresolvablePath extends Error {
  constructor() {
    super("path_unresolvable");
    this.name = "UnresolvablePath";
  }
}

const MAX_LINKS = 40;

/**
 * The path with every symlink resolved. The part that does not exist yet is kept as written, except that a dangling symlink is followed to the
 * place it names (read with `readlinkSync`, recursively), so the floor sees where a write would really land. Anything else that cannot be
 * resolved fails closed with `UnresolvablePath`.
 */
function realOf(value: string, links = { n: 0 }): string {
  try {
    return realpathSync(value);
  } catch {
    // fx-swallow-ok: not resolvable by realpath; the cases below decide, and anything unexpected throws UnresolvablePath
  }
  let stat;
  try {
    stat = lstatSync(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new UnresolvablePath();
    const cut = value.lastIndexOf("/");
    if (cut <= 0) return value;
    return `${realOf(value.slice(0, cut), links)}/${value.slice(cut + 1)}`.replace(/^\/\//, "/");
  }
  if (!stat.isSymbolicLink()) throw new UnresolvablePath();
  links.n += 1;
  if (links.n > MAX_LINKS) throw new UnresolvablePath();
  let target: string;
  try {
    target = readlinkSync(value);
  } catch {
    // fx-swallow-ok: an unreadable link fails closed
    throw new UnresolvablePath();
  }
  return realOf(path.resolve(path.dirname(value), target), links);
}

/**
 * Each path entry as it really lands on this machine. A symlink in an allowed path is followed, and the entry is the place it leads to, so the floor
 * is checked on, and the sandbox is bound to, the real place (a link in `/tmp` into a credential directory is that directory). `/private/tmp` is
 * macOS's own `/tmp` and is read as `/tmp`. Entries of other kinds are unchanged. Throws `UnresolvablePath` for a path that cannot be resolved.
 */
export function resolveEntries(entries: readonly AllowanceEntry[]): AllowanceEntry[] {
  return entries.map((entry) => {
    if (entry.kind !== "path") return entry;
    const real = realOf(entry.value).replace(/^\/private\/tmp(?=\/|$)/, "/tmp");
    return real === entry.value ? entry : { ...entry, value: real };
  });
}

/** The result of `checkedAllowances`: the entries resolved ONCE and floor-checked, or the closed reason they may not be applied. */
export type CheckedAllowances = { ok: true; entries: AllowanceEntry[] } | { ok: false; code: AllowanceRefusal };

/**
 * Parses the set, resolves its paths once, and checks the protocol's floor on the entries as written and on the resolved entries. The entries it
 * returns are the very list that was checked: the caller binds these and resolves nothing again, so there is no swap window between check and bind.
 * (A hostname that resolves to a private address is not caught here: the egress proxy connects, and this runner does not.)
 */
export function checkedAllowances(grant: { entries: readonly AllowanceEntry[]; commandTimeoutS: number }): CheckedAllowances {
  const parsed = parseAllowanceSet({ entries: grant.entries, command_timeout_s: grant.commandTimeoutS });
  if (!parsed.ok) return { ok: false, code: parsed.code };
  // A job key never holds an empty set (the cloud omits it); one that does is not a job the cloud signs.
  if (parsed.set.entries.length === 0) return { ok: false, code: "invalid_shape" };
  let resolved: AllowanceEntry[];
  try {
    resolved = resolveEntries(grant.entries);
  } catch (error) {
    if (error instanceof UnresolvablePath) return { ok: false, code: "path_malformed" };
    throw error;
  }
  for (const real of resolved) {
    const code = allowanceFloorViolation(real);
    if (code !== null) return { ok: false, code };
  }
  return { ok: true, entries: resolved };
}

/** Why a job's allowance set may not be applied, or null when it clears the protocol's floor, both as written and where each path really lands. */
export function allowanceRefusal(grant: { entries: readonly AllowanceEntry[]; commandTimeoutS: number }): AllowanceRefusal | null {
  const checked = checkedAllowances(grant);
  return checked.ok ? null : checked.code;
}

/** What the sandbox builder is given for a set that cleared the floor. */
export interface AllowanceGrants {
  readPaths: string[];
  writePaths: string[];
  domains: string[];
  loopback: boolean;
}

export function grantsOf(entries: readonly AllowanceEntry[]): AllowanceGrants {
  const unique = (values: string[]): string[] => [...new Set(values)];
  return {
    readPaths: unique(entries.filter((entry) => entry.kind === "path" && entry.access === "read").map((entry) => entry.value)),
    writePaths: unique(entries.filter((entry) => entry.kind === "path" && entry.access === "write").map((entry) => entry.value)),
    domains: unique(entries.filter((entry) => entry.kind === "domain").map((entry) => entry.value)),
    loopback: entries.some((entry) => entry.kind === "loopback"),
  };
}

/**
 * The repo's package store is one directory per repo, named by the repo's id (as the mirrors are): never shared with another repo, valid for every
 * repo name GitHub allows, and a repo deleted and recreated under the same name has a new id and gets a new, empty store.
 */
export function storeKeyOf(repo: { id: string }): string {
  return repo.id;
}

/**
 * The per-job environment an allowance job starts with, over the clean one. `store` is the repo's package store (absent when the runner keeps
 * none); the cache directory is under the job's own temp directory, which is removed with the sandbox. The Bash tool's default and longest
 * timeouts are the job's `command_timeout_s`, in milliseconds.
 */
export function jobEnvFor(input: { tempDir: string; store?: string; commandTimeoutS: number }): Record<string, string> {
  const ms = String(input.commandTimeoutS * 1000);
  return {
    XDG_CACHE_HOME: `${input.tempDir.replace(/\/+$/, "")}/xdg-cache`,
    ...(input.store === undefined ? {} : { npm_config_store_dir: input.store, npm_config_verify_store_integrity: "true" }),
    BASH_DEFAULT_TIMEOUT_MS: ms,
    BASH_MAX_TIMEOUT_MS: ms,
  };
}
