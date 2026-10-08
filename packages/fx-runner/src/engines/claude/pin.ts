import { accessSync, constants, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { REQUIRED_FLAGS } from "./argv.js";
import { runCapture, type SpawnFn } from "./capture.js";
import { EngineRefusal } from "./refusal.js";

/**
 * The lowest build the runner accepts: the oldest one the real-binary canary (`scripts/canary.sh`) has been run on and
 * passed, which is what proves the file-tool confinement settings (`permissions.deny`, `blockReadsOutsideWorkingDirectories`)
 * are honoured. Change it in this one place, to the version the canary printed. Every flag in `REQUIRED_FLAGS` exists well
 * below it (`--permission-prompts`, the newest, is 2.1.259, from the CLI reference); the flag check below is the real test
 * for those, this constant keeps the refusal message and the doctor output simple.
 */
export const MIN_CLAUDE_VERSION = "2.1.294";

/** The one thing the engine is given: where the binary is, and which version it reported. */
export interface ClaudeBinary {
  path: string;
  version: string;
}

/** Where a job's binary comes from. v1 resolves a stored path (`storedBinarySource`); a VM image could supply its own. */
export type BinarySource = (env: Record<string, string>) => Promise<ClaudeBinary>;

/** `2.1.289 (Claude Code)` gives `2.1.289`; anything that does not start with three dotted numbers gives undefined. */
export function parseVersion(text: string): string | undefined {
  const first = text.trim().split(/\s+/)[0] ?? "";
  return /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(first) ? first : undefined;
}

/** Negative, zero or positive as `a` is older than, equal to or newer than `b`. Both must be parsed versions. */
export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return (left[i] ?? 0) - (right[i] ?? 0);
  return 0;
}

export function versionSupported(version: string): boolean {
  return compareVersions(version, MIN_CLAUDE_VERSION) >= 0;
}

function assertRunnable(file: string): void {
  try {
    if (!path.isAbsolute(file) || !statSync(file).isFile()) throw new Error("not a file");
    accessSync(file, constants.X_OK);
  } catch {
    throw new EngineRefusal("claude_binary_missing", "the stored path is missing or not executable");
  }
}

/**
 * Setup time only (`fx-runner login`): finds `claude` in the directories of `searchPath`, resolves links, and returns
 * its absolute real path to be stored. The search path is an argument, never read here, and nothing at job time calls this.
 */
export function resolveClaudePath(searchPath: string): string {
  for (const dir of searchPath.split(path.delimiter)) {
    if (dir === "" || !path.isAbsolute(dir)) continue;
    try {
      const real = realpathSync(path.join(dir, "claude"));
      assertRunnable(real);
      return real;
    } catch {
      // fx-swallow-ok: a directory without a runnable claude is simply skipped; none found is refused below
    }
  }
  throw new EngineRefusal("claude_binary_missing", "no runnable claude found on the search path");
}

/** The flags `--help` lists, by version. Plain JSON of names, never help text. */
type FlagCache = Record<string, { missing: string[] }>;

function readCache(file: string): FlagCache {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as FlagCache) : {};
  } catch {
    // fx-swallow-ok: a missing or damaged cache only means `--help` is read again
    return {};
  }
}

function missingFlags(help: string): string[] {
  return REQUIRED_FLAGS.filter((flag) => !new RegExp(`(?:^|[\\s,|])${flag}(?=[\\s,<\\[=|]|$)`, "m").test(help));
}

/**
 * The v1 source: the stored absolute path, checked before every job. A missing or non-executable path is
 * `claude_binary_missing`. `--version` must parse and be at least `MIN_CLAUDE_VERSION` (`claude_version_unsupported`,
 * with an upgrade hint). `--help` must list every flag the argument list uses (`claude_flags_unsupported`, naming them);
 * it is read once per version and the answer is cached in `cacheDir`, so a new version is checked afresh. No model request.
 */
export function storedBinarySource(opts: { storedPath: string; cacheDir: string; spawn: SpawnFn; timeoutMs?: number }): BinarySource {
  return async (env) => {
    assertRunnable(opts.storedPath);
    const timeout = opts.timeoutMs ?? 10_000;
    const reported = await runCapture(opts.spawn, opts.storedPath, ["--version"], env, timeout);
    const version = reported.code === 0 ? parseVersion(reported.stdout) : undefined;
    if (version === undefined) throw new EngineRefusal("claude_version_unsupported", `the binary's version could not be read; upgrade Claude Code to ${MIN_CLAUDE_VERSION} or newer`);
    if (!versionSupported(version)) throw new EngineRefusal("claude_version_unsupported", `version ${version} is older than ${MIN_CLAUDE_VERSION}; upgrade Claude Code`);
    const cacheFile = path.join(opts.cacheDir, "claude-flags.json");
    const cache = readCache(cacheFile);
    let entry = Object.hasOwn(cache, version) ? cache[version] : undefined;
    if (entry === undefined || !Array.isArray(entry.missing)) {
      const help = await runCapture(opts.spawn, opts.storedPath, ["--help"], env, timeout, 512 * 1024);
      if (help.code !== 0) throw new EngineRefusal("claude_flags_unsupported", "the binary's --help could not be read");
      entry = { missing: missingFlags(help.stdout) };
      mkdirSync(opts.cacheDir, { recursive: true, mode: 0o700 });
      const temp = `${cacheFile}.tmp`;
      writeFileSync(temp, `${JSON.stringify({ ...cache, [version]: entry })}\n`, { mode: 0o600 });
      renameSync(temp, cacheFile);
    }
    if (entry.missing.length > 0) throw new EngineRefusal("claude_flags_unsupported", `version ${version} lacks ${entry.missing.filter((flag) => REQUIRED_FLAGS.includes(flag)).join(", ")}; upgrade Claude Code`);
    return { path: opts.storedPath, version };
  };
}
