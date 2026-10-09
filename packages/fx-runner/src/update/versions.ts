/**
 * What the updater keeps on disk (D#6 R6-2b, correction C38 section 2), in the layout `install.sh` makes:
 *
 *   <stateDir>/versions/<v>/fx-runner     one directory per version, the file 0755
 *   <stateDir>/bin/fx-runner              a relative symlink to ../versions/<v>/fx-runner: the stable path the service unit runs
 *   <stateDir>/update.json                0600, no secret: the pin, the auto-update switch, the last check and the kept previous version
 *
 * The link is only ever replaced by renaming a new link over it, so a reader sees the old target or the new one, never none.
 */
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { readPrivateFile, writePrivateFile } from "../config.js";

export const UPDATE_STATE_FILE = "update.json";
export const BINARY_NAME = "fx-runner";

const SEMVER = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

/** `x.y.z` only: a build tag, a pre-release or anything else is not a version this updater will install or compare. */
export function isVersion(text: unknown): text is string {
  return typeof text === "string" && SEMVER.test(text);
}

/** Negative when `a` is older than `b`, zero when equal, positive when newer. Both must pass `isVersion`. */
export function compareVersions(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
  return 0;
}

export const versionsDir = (stateDir: string): string => path.join(stateDir, "versions");
export const binDir = (stateDir: string): string => path.join(stateDir, "bin");
export const stableBinary = (stateDir: string): string => path.join(binDir(stateDir), BINARY_NAME);
export const versionBinary = (stateDir: string, version: string): string => path.join(versionsDir(stateDir), version, BINARY_NAME);

/** The version the stable link points at, or undefined when there is no link or it is not one this layout makes. */
export function linkedVersion(stateDir: string): string | undefined {
  try {
    const target = readlinkSync(stableBinary(stateDir));
    const match = target.match(/^\.\.\/versions\/([^/]+)\/fx-runner$/);
    return match !== null && isVersion(match[1]) ? match[1] : undefined;
  } catch {
    // fx-swallow-ok: no link, or not a link: the install is not one this updater manages
    return undefined;
  }
}

/** True when `dir` is a real directory: `lstat` does not follow, so a symbolic link to a directory is not one. */
export function isRealDirectory(dir: string): boolean {
  try {
    return lstatSync(dir).isDirectory();
  } catch {
    // fx-swallow-ok: missing means not a directory
    return false;
  }
}

/** True when `<stateDir>/versions` and `<stateDir>/bin` are both real directories. A link in either place could point reads, deletes and installs outside the tree. */
export function layoutIsSafe(stateDir: string): boolean {
  return isRealDirectory(versionsDir(stateDir)) && isRealDirectory(binDir(stateDir));
}

/** True when `<stateDir>/versions/<v>` is a real directory and `<stateDir>/versions/<v>/fx-runner` is a plain file (no link at any step). */
export function versionInstalled(stateDir: string, version: string): boolean {
  try {
    if (!isRealDirectory(versionsDir(stateDir)) || !isRealDirectory(path.join(versionsDir(stateDir), version))) return false;
    return lstatSync(versionBinary(stateDir, version)).isFile();
  } catch {
    // fx-swallow-ok: missing means not installed
    return false;
  }
}

function lstatExists(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch {
    // fx-swallow-ok: missing
    return false;
  }
}

/** Points the stable path at `version` by renaming a new link over the old one: atomic on a real filesystem. */
export function switchLink(stateDir: string, version: string): void {
  const dir = binDir(stateDir);
  // A link in the bin directory would put the new link, and so the program the service starts, outside the tree: refuse before creating anything.
  if (lstatExists(dir) && !isRealDirectory(dir)) throw new Error("bin is not a real directory");
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const temp = path.join(dir, `.fx-runner.new.${randomBytes(6).toString("hex")}`);
  try {
    symlinkSync(`../versions/${version}/${BINARY_NAME}`, temp);
    renameSync(temp, stableBinary(stateDir));
  } finally {
    rmSync(temp, { force: true });
  }
}

/** The version directories on disk (names that are versions; staging directories and anything else are not listed). */
export function installedVersions(stateDir: string): string[] {
  try {
    if (!isRealDirectory(versionsDir(stateDir))) return [];
    return readdirSync(versionsDir(stateDir)).filter(isVersion);
  } catch {
    // fx-swallow-ok: no versions directory means none installed
    return [];
  }
}

export interface UpdateState {
  version: 1;
  /** Automatic updates (`config set auto-update`). Default on. */
  autoUpdate: boolean;
  /** An explicit pin: automatic updates hold this version. */
  pinned?: string;
  /** ISO time of the last check against the release metadata. */
  lastCheck?: string;
  /** The newest version the verified metadata offers this platform, as of the last check. */
  available?: string;
  /** Why updates are paused, when they are (always a closed text). */
  paused?: string;
  /** Why the last check failed for any reason but an expired timestamp (a network error, a refusal): shown as a failed check, not as a pause. */
  checkFailed?: string;
  /** The one kept earlier version `--rollback` returns to. */
  previous?: string;
  /** A version whose start check failed or that was rolled back from: automatic updates skip it. */
  failed?: string;
  /** Written before a version is staged, cleared when the switch is complete: what a crash leaves tells the next run what to clean. */
  applying?: { version: string; from?: string };
  /** Set when update.json was unreadable: automatic updates are off until it is fixed. */
  damaged?: boolean;
}

export const DEFAULT_STATE: UpdateState = { version: 1, autoUpdate: true };

function isoOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

/** The saved state. A file that is missing is the default; one that is damaged turns automatic updates off and says so. */
export function loadUpdateState(stateDir: string): UpdateState {
  let text: string | undefined;
  try {
    text = readPrivateFile(stateDir, UPDATE_STATE_FILE);
  } catch {
    // fx-swallow-ok: an unreadable file is reported as damaged state; the reason text may carry a path
    return { ...DEFAULT_STATE, autoUpdate: false, damaged: true };
  }
  if (text === undefined) return { ...DEFAULT_STATE };
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (raw === null || typeof raw !== "object" || raw["version"] !== 1 || typeof raw["autoUpdate"] !== "boolean") throw new Error("shape");
    const state: UpdateState = { version: 1, autoUpdate: raw["autoUpdate"] };
    if (isVersion(raw["pinned"])) state.pinned = raw["pinned"];
    if (isVersion(raw["available"])) state.available = raw["available"];
    if (isVersion(raw["previous"])) state.previous = raw["previous"];
    if (isVersion(raw["failed"])) state.failed = raw["failed"];
    const lastCheck = isoOrUndefined(raw["lastCheck"]);
    if (lastCheck !== undefined) state.lastCheck = lastCheck;
    if (typeof raw["paused"] === "string") state.paused = raw["paused"].slice(0, 200);
    if (typeof raw["checkFailed"] === "string") state.checkFailed = raw["checkFailed"].slice(0, 200);
    const applying = raw["applying"] as { version?: unknown; from?: unknown } | undefined;
    if (applying !== undefined && isVersion(applying.version)) state.applying = { version: applying.version, ...(isVersion(applying.from) ? { from: applying.from } : {}) };
    return state;
  } catch {
    // fx-swallow-ok: damaged state turns automatic updates off; nothing from the file is shown
    return { ...DEFAULT_STATE, autoUpdate: false, damaged: true };
  }
}

export function saveUpdateState(stateDir: string, state: UpdateState): void {
  const rest: UpdateState = { ...state };
  delete rest.damaged;
  writePrivateFile(stateDir, UPDATE_STATE_FILE, `${JSON.stringify(rest, null, 2)}\n`);
}
