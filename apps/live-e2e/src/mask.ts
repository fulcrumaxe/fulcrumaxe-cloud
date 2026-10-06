/**
 * The registry of runtime secrets (SE3). A value that only exists while a run is going (a decrypted session
 * JWT, the bypass cookie, a minted token, a webhook signing secret) is registered here the moment it exists:
 * it is announced to the CI log as a mask (`::add-mask::`) and tracked so the scrub finds it, in any artifact,
 * even when it was created after the scan began.
 *
 * Runtime values are made in the Playwright worker processes and read by the scrub in another, so the registry
 * can also be backed by a file (`LIVE_E2E_MASK_FILE`). That file holds the raw values: it is created 0600,
 * must live outside the artifact folder, and the scrub refuses to run when it sits inside the folder it scans.
 */
import { closeSync, constants, fstatSync, openSync, readFileSync, writeSync } from "node:fs";

export const MASK_FILE_ENV = "LIVE_E2E_MASK_FILE";
/** Shorter values are announced to the CI log but not tracked: matching them as substrings would flag everything. */
export const MIN_TRACKED_LENGTH = 8;

// TODO(T1b): `::add-mask::` must be printed by the MAIN process, not by a Playwright worker. A worker's stdout
// goes through Playwright's reporters, which may prefix, buffer or store it (even in a report attachment), so
// the runner might never see the command at the start of a line and the line itself, value included, could end
// up in a report. T1b should register values in workers with `emit` set to a no-op (they still reach the mask
// file) and have the main process (a reporter or a watcher tailing the mask file) print the commands.

export class MaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaskError";
  }
}

/** GitHub workflow-command data escaping: `%`, CR and LF would otherwise end or alter the command. */
function escapeData(s: string): string {
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

export interface MaskOptions {
  /** Where `::add-mask::` lines go. Default: standard output, which the Actions runner reads. */
  emit?: (line: string) => void;
  /** Persist registered values here (0600), so another process can scrub with them. */
  file?: string;
  /**
   * With `file`: true makes this registry the owner, which creates the file (it must not exist yet).
   * Otherwise the file must already exist. Either way it must be a regular file, ours, with no group/other access.
   */
  create?: boolean;
}

/** What the mask file must be: a regular file owned by this user that nobody else can read or write. */
export function checkMaskStat(st: { isFile(): boolean; uid: number; mode: number }, uid: number | undefined, path: string): void {
  if (!st.isFile()) throw new MaskError(`mask file ${path} is not a regular file`);
  if (uid !== undefined && st.uid !== uid) throw new MaskError(`mask file ${path} is owned by another user`);
  if ((st.mode & 0o077) !== 0) throw new MaskError(`mask file ${path} is accessible to group or others (mode ${(st.mode & 0o777).toString(8)})`);
}

const { O_APPEND, O_CREAT, O_EXCL, O_NOFOLLOW, O_RDONLY, O_WRONLY } = constants;

function openChecked(path: string, flags: number, mode?: number): number {
  let fd: number;
  try {
    fd = mode === undefined ? openSync(path, flags | O_NOFOLLOW) : openSync(path, flags | O_NOFOLLOW, mode);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ELOOP") throw new MaskError(`mask file ${path} is a symbolic link`);
    if (code === "EEXIST") throw new MaskError(`mask file ${path} already exists; the owner must create it`);
    if (code === "ENOENT") throw new MaskError(`mask file ${path} does not exist`);
    throw new MaskError(`mask file ${path} cannot be opened (${code ?? "error"})`);
  }
  try {
    checkMaskStat(fstatSync(fd), process.getuid?.(), path);
  } catch (err) {
    closeSync(fd);
    throw err;
  }
  return fd;
}

export class MaskRegistry {
  private readonly tracked = new Set<string>();
  private readonly emit: (line: string) => void;
  readonly file: string | undefined;
  /** Bumped whenever a new value is tracked; the scan uses it to notice values that appeared mid-scan. */
  version = 0;

  constructor(options: MaskOptions = {}) {
    this.emit = options.emit ?? ((line) => void process.stdout.write(`${line}\n`));
    this.file = options.file;
    if (this.file !== undefined) {
      if (options.create === true) {
        // One owner creates it, atomically: O_EXCL refuses an existing file, O_NOFOLLOW a symlink (also a dangling one).
        closeSync(openChecked(this.file, O_CREAT | O_EXCL | O_WRONLY, 0o600));
      }
      this.loadFile();
    }
  }

  /**
   * Registers a secret. Announces the mask before returning, so nothing the caller logs next can leak it.
   * Returns true when the value is tracked for scanning (long enough), false when it was only announced.
   */
  register(value: string): boolean {
    if (value.length === 0) throw new MaskError("refusing to register an empty value");
    // Each non-empty line is its own mask: the runner masks per log line.
    for (const line of value.split(/\r?\n/)) {
      if (line.length > 0) this.emit(`::add-mask::${escapeData(line)}`);
    }
    const added = this.track(value);
    if (added && this.file !== undefined) {
      const fd = openChecked(this.file, O_WRONLY | O_APPEND);
      try {
        writeSync(fd, `${JSON.stringify(value)}\n`);
      } finally {
        closeSync(fd);
      }
    }
    return value.length >= MIN_TRACKED_LENGTH;
  }

  /** Re-reads the backing file, picking up values another process registered. */
  loadFile(): void {
    if (this.file === undefined) return;
    const fd = openChecked(this.file, O_RDONLY);
    let content: string;
    try {
      content = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
    for (const line of content.split("\n")) {
      if (line.length === 0) continue;
      let v: unknown;
      try {
        v = JSON.parse(line);
      } catch {
        throw new MaskError(`mask file ${this.file} has a line that is not JSON`);
      }
      if (typeof v !== "string") throw new MaskError(`mask file ${this.file} has a non-string value`);
      this.track(v);
    }
  }

  private track(value: string): boolean {
    if (value.length < MIN_TRACKED_LENGTH || this.tracked.has(value)) return false;
    this.tracked.add(value);
    this.version += 1;
    return true;
  }

  /** The tracked values, newest state. Callers must not log them. */
  values(): string[] {
    return [...this.tracked];
  }
}

/**
 * Names whose values are public by design and appear in reports (commit, repository, paths). Everything else
 * in the run's own environment counts as secret: failing on a harmless match is safe, missing a secret is not.
 * A name that looks like a credential is secret even if it falls under one of these.
 */
const PUBLIC_ENV_NAMES = new Set([
  "PATH", "HOME", "PWD", "OLDPWD", "SHELL", "USER", "LOGNAME", "LANG", "LANGUAGE", "TERM", "TMPDIR", "TMP", "TEMP", "TEMPDIR",
  "HOSTNAME", "CI", "NODE_ENV", "NODE_PATH", "INIT_CWD", "EDITOR", "PAGER", "LS_COLORS", "COLORTERM", "DISPLAY",
  "TZ", "SHLVL", "_", "PS1", "MANPATH", "INFOPATH", "OSTYPE", "HOSTTYPE", "MACHTYPE",
]);
const PUBLIC_ENV_PREFIXES = ["GITHUB_", "RUNNER_", "XDG_", "NIX_", "LC_", "npm_", "PNPM_", "ACTIONS_", "INPUT_", "FORCE_", "PLAYWRIGHT_"];
const SECRET_NAME = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|COOKIE|AUTH|CREDENTIAL|BYPASS|SESSION|JWT|SIGNING|PRIVATE|DATABASE_URL|CONNECTION_STRING)|(^|_)(PAT|PASS|DSN)(_|$)/i;
/** Runner-provided names that look secret but hold file paths, not values. */
const NOT_SECRET_NAMES = new Set(["GITHUB_ACTIONS", "GITHUB_EVENT_PATH", "GITHUB_ENV", "GITHUB_PATH", "GITHUB_OUTPUT", "GITHUB_STATE", "GITHUB_STEP_SUMMARY", "GITHUB_ACTION_PATH"]);

/**
 * A value that is only an absolute path under a well-known filesystem root (or a list of them, like PATH) is public:
 * Playwright's JSON and our logs print rootDir, outputDir and configFile, and a secret does not look like this.
 * The root must be one of these, so a base64 secret that happens to start with a slash is still secret.
 */
const PATH_ROOTS = /^\/(?:home|tmp|var|usr|opt|nix|run|etc|root|mnt|srv|bin|sbin|lib|lib64|dev|proc|sys|Users|private|workspace|github|__w)(?:\/[A-Za-z0-9._@~+-]+)*\/?$/;
export function isPathValue(value: string): boolean {
  return value.split(":").every((part) => PATH_ROOTS.test(part));
}

/** Values from the run's own environment that the scrub must never find in an artifact. */
export function envSecretValues(env: Record<string, string | undefined>, extraNames: readonly string[] = []): string[] {
  const out = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value.length < MIN_TRACKED_LENGTH) continue;
    if (NOT_SECRET_NAMES.has(name)) continue;
    const declared = extraNames.includes(name);
    if (!declared && isPathValue(value)) continue;
    const secretLooking = SECRET_NAME.test(name);
    const publicName = PUBLIC_ENV_NAMES.has(name) || PUBLIC_ENV_PREFIXES.some((p) => name.startsWith(p));
    if (declared || secretLooking || !publicName) out.add(value);
  }
  return [...out];
}
