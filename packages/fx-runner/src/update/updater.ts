/**
 * Applying updates (D#6 R6-2b, correction C38 section 2). `tuf.ts` hands back a verified file and installs nothing; this file is the
 * only place that installs one.
 *
 * What it guarantees, and how:
 *  - Only what TUF verified. A new version is a `fetchTarget` result. The one other thing it switches to is the kept previous version,
 *    which this updater staged earlier.
 *  - Never down by itself. An automatic update must be newer than the version the stable link points at; only `--pin` and `--rollback`,
 *    which the person types, may name an older one.
 *  - Staged, checked, then switched. The file is copied into a private staging directory, its hash is checked again, it is moved to
 *    `versions/<v>/fx-runner` (0755) and asked to start (`--version`, then `doctor --sandbox-only`, the probe `install.sh` runs). Only
 *    then does the stable link change, by renaming a new link over the old one. If the program started through the link fails the same
 *    check, the link goes back and that version is marked failed so it is not tried again.
 *  - Fail closed. Any refusal or error leaves the link, and so the version that restarts next, where it was.
 *  - One previous version is kept; older ones are removed once a switch is complete.
 *  - A running program is never changed: nothing is overwritten in place, only the link moves. A program that is running (a job in
 *    hand included) keeps the file it started from, so a switch takes effect at the next start. The daemon additionally checks only
 *    while it holds no lease (`AutoUpdate`), so no download competes with a job.
 *  - A Homebrew install, or any run that does not start out of `<state dir>/versions/`, is never switched: the stable link is not what runs there.
 */
import { createHash, randomBytes } from "node:crypto";
import { constants, chmodSync, closeSync, copyFileSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import type { TufClient } from "./tuf.js";
import { compareVersions, installedVersions, isVersion, layoutIsSafe, linkedVersion, loadUpdateState, saveUpdateState, switchLink, versionBinary, versionInstalled, versionsDir, stableBinary, type UpdateState } from "./versions.js";

/** What the program's entry point knows and does for the updater; nothing under `src/` starts a program or reads the environment. */
export interface UpdateHost {
  /** The version this program is. */
  version: string;
  platform: NodeJS.Platform;
  arch: string;
  /** Where this program really is (symlinks resolved). */
  execPath: string;
  /** True when a service manager started this program (`FX_RUNNER_SERVICE=1`, which the unit sets). */
  inService: boolean;
  /** Runs a program with a clean environment and a time limit; never rejects. */
  run: (file: string, args: readonly string[], timeoutMs: number) => Promise<{ code: number | null; stdout: string }>;
}

export interface UpdaterDeps {
  stateDir: string;
  host: UpdateHost;
  now: () => Date;
  tuf: Pick<TufClient, "configured" | "fetchTarget" | "listTargets">;
}

export type UpdateResult = { ok: true; message: string; version?: string } | { ok: false; code: string; message: string };

export const CHECK_INTERVAL_MS = 6 * 3_600_000;
const LOCK_FILE = "update.lock";
const LOCK_STALE_MS = 15 * 60_000;
const VERSION_CHECK_MS = 30_000;
const SANDBOX_CHECK_MS = 90_000;

/** The platforms a release ships (the file names of `release-manifest.mjs`). */
export function releasePlatform(platform: NodeJS.Platform, arch: string): string | undefined {
  const os = platform === "linux" || platform === "darwin" ? platform : undefined;
  const cpu = arch === "x64" || arch === "arm64" ? arch : undefined;
  return os === undefined || cpu === undefined ? undefined : `${os}-${cpu}`;
}

const HOMEBREW = /^(?:\/opt\/homebrew|\/usr\/local\/Cellar|\/usr\/local\/Homebrew|\/home\/linuxbrew\/\.linuxbrew)(?:\/|$)|\/Cellar\//;
export const isHomebrewPath = (file: string): boolean => HOMEBREW.test(file);

export const BREW_LINE = "A newer version is available: run brew upgrade fx-runner";

export type InstallKind = "homebrew" | "managed" | "unmanaged";

const within = (child: string, parent: string): boolean => child.startsWith(`${parent}${path.sep}`);

function realOr(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    // fx-swallow-ok: a path that does not exist resolves to itself
    return file;
  }
}

const sha256 = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");

export class Updater {
  constructor(private readonly deps: UpdaterDeps) {}

  private get stateDir(): string {
    return this.deps.stateDir;
  }

  get dir(): string {
    return this.deps.stateDir;
  }

  get configured(): boolean {
    return this.deps.tuf.configured;
  }

  /** Homebrew, managed (this program starts out of `versions/` in the state directory and the stable link is one this layout makes), or neither. */
  kind(): InstallKind {
    const program = this.deps.host.execPath;
    if (isHomebrewPath(program)) return "homebrew";
    // The running program must sit under the LEXICAL versions directory of the resolved state directory, and versions and bin must be real
    // directories there: resolving a link in either would let a link out of the tree count as this install.
    if (linkedVersion(this.stateDir) !== undefined && layoutIsSafe(this.stateDir) && within(program, path.join(realOr(this.stateDir), "versions"))) return "managed";
    return "unmanaged";
  }

  /** The version the stable link names now (the next start), else the running version. */
  current(): string {
    return linkedVersion(this.stateDir) ?? this.deps.host.version;
  }

  private guard(): UpdateResult | undefined {
    const kind = this.kind();
    if (kind === "homebrew") return { ok: false, code: "homebrew", message: "this install is managed by Homebrew; run: brew upgrade fx-runner" };
    if (kind === "unmanaged") return { ok: false, code: "unmanaged", message: "this program was not installed by install.sh, so it does not update itself" };
    return undefined;
  }

  private async withLock<T>(fn: () => Promise<T>, busy: T): Promise<T> {
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    const file = path.join(this.stateDir, LOCK_FILE);
    const take = (): boolean => {
      try {
        closeSync(openSync(file, "wx", 0o600));
        return true;
      } catch {
        // fx-swallow-ok: the lock is held; the caller decides
        return false;
      }
    };
    if (!take()) {
      let age = 0;
      try {
        age = this.deps.now().getTime() - lstatSync(file).mtimeMs;
      } catch {
        // fx-swallow-ok: the lock vanished between the two calls; taking it again decides
      }
      if (age <= LOCK_STALE_MS) return busy;
      // Take a stale lock over without ever deleting a fresh one: move it aside under a name only this process uses, look at what was
      // really moved, and put it back (if the name is free) when it turns out to be a lock another process had just taken.
      const aside = `${file}.stale-${randomBytes(6).toString("hex")}`;
      try {
        renameSync(file, aside);
      } catch {
        // fx-swallow-ok: someone else took it over first; the caller decides
        return busy;
      }
      let movedAge = Infinity;
      try {
        movedAge = this.deps.now().getTime() - lstatSync(aside).mtimeMs;
      } catch {
        // fx-swallow-ok: unreadable means not provably stale
      }
      if (movedAge <= LOCK_STALE_MS) {
        try {
          linkSync(aside, file);
        } catch {
          // fx-swallow-ok: a newer lock already exists, which is the one that counts
        }
        rmSync(aside, { force: true });
        return busy;
      }
      rmSync(aside, { force: true });
      if (!take()) return busy;
    }
    try {
      return await fn();
    } finally {
      rmSync(file, { force: true });
    }
  }

  /** Removes what an interrupted update left, and finishes one that switched but did not record it. Safe to call at any time. */
  async cleanup(): Promise<void> {
    await this.withLock(async () => this.cleanupLocked(), undefined);
  }

  private cleanupLocked(): void {
    if (!layoutIsSafe(this.stateDir)) return;
    try {
      for (const name of readdirSync(versionsDir(this.stateDir))) if (name.startsWith(".staging-")) rmSync(path.join(versionsDir(this.stateDir), name), { recursive: true, force: true });
    } catch {
      // fx-swallow-ok: no versions directory, nothing to clean
    }
    const state = loadUpdateState(this.stateDir);
    if (state.damaged === true) return;
    const applying = state.applying;
    if (applying === undefined) return;
    const linked = linkedVersion(this.stateDir);
    delete state.applying;
    if (linked === applying.version) {
      if (applying.from !== undefined && versionInstalled(this.stateDir, applying.from)) state.previous = applying.from;
      this.prune(state, linked);
    } else if (applying.version !== state.previous) {
      rmSync(path.join(versionsDir(this.stateDir), applying.version), { recursive: true, force: true });
    }
    saveUpdateState(this.stateDir, state);
  }

  private prune(state: UpdateState, current: string): void {
    if (!layoutIsSafe(this.stateDir)) return;
    for (const version of installedVersions(this.stateDir)) {
      if (version !== current && version !== state.previous) rmSync(path.join(versionsDir(this.stateDir), version), { recursive: true, force: true });
    }
  }

  /** Asks the new program to prove it starts: its version line, then the sandbox probe. Any error is a failure. */
  private async startCheck(binary: string, version: string): Promise<boolean> {
    try {
      const said = await this.deps.host.run(binary, ["--version"], VERSION_CHECK_MS);
      const first = said.stdout.split("\n", 1)[0] ?? "";
      if (said.code !== 0 || !(first === `fx-runner ${version}` || first.startsWith(`fx-runner ${version} `))) return false;
      const probe = await this.deps.host.run(binary, ["doctor", "--sandbox-only"], SANDBOX_CHECK_MS);
      return probe.code === 0;
    } catch {
      // fx-swallow-ok: a program that cannot be run fails its check
      return false;
    }
  }

  /** Looks at the verified release metadata and records what it found. Installs nothing. */
  async check(): Promise<{ ok: true; current: string; available: string | undefined } | { ok: false; state: "not_configured" | "paused" | "refused"; message: string }> {
    if (!this.deps.tuf.configured) return { ok: false, state: "not_configured", message: "updates are not configured in this build" };
    const platform = releasePlatform(this.deps.host.platform, this.deps.host.arch);
    const state = loadUpdateState(this.stateDir);
    const stamp = this.deps.now().toISOString();
    if (platform === undefined) return { ok: false, state: "refused", message: "there is no release for this platform" };
    const listed = await this.deps.tuf.listTargets();
    if (!listed.ok) {
      const reason = listed.state === "paused" ? (listed.expiredOn === undefined ? "release metadata expired" : `release metadata expired on ${listed.expiredOn}`) : listed.state === "not_configured" ? "updates are not configured in this build" : listed.message;
      const rest: UpdateState = { ...state, lastCheck: stamp };
      delete rest.paused;
      delete rest.checkFailed;
      if (listed.state === "paused") this.record({ ...rest, paused: reason });
      else if (listed.state !== "not_configured") this.record({ ...rest, checkFailed: reason });
      return { ok: false, state: listed.state === "paused" ? "paused" : listed.state === "not_configured" ? "not_configured" : "refused", message: listed.state === "paused" ? `updates paused: ${reason}` : listed.message };
    }
    let best: string | undefined;
    for (const target of listed.paths) {
      const match = target.match(/^v([^/]+)\/fx-runner-([a-z0-9-]+)$/);
      if (match === null || match[2] !== platform || !isVersion(match[1])) continue;
      if (best === undefined || compareVersions(match[1], best) > 0) best = match[1];
    }
    const next: UpdateState = { ...state, lastCheck: stamp };
    delete next.paused;
    delete next.checkFailed;
    delete next.available;
    if (best !== undefined) next.available = best;
    this.record(next);
    return { ok: true, current: this.current(), available: best };
  }

  private record(state: UpdateState): void {
    if (state.damaged === true) return;
    saveUpdateState(this.stateDir, state);
  }

  /** The automatic path: check, and install the newest version if it is newer than what the link names. Honours the pin and a failed version. */
  async applyLatest(): Promise<UpdateResult> {
    const blocked = this.guard();
    if (blocked !== undefined) return blocked;
    const before = loadUpdateState(this.stateDir);
    if (before.damaged === true) return { ok: false, code: "state_damaged", message: "update.json is damaged, so automatic updates are off" };
    if (before.pinned !== undefined) return { ok: true, message: `held at ${before.pinned} by a pin` };
    const checked = await this.check();
    if (!checked.ok) return { ok: false, code: checked.state, message: checked.message };
    const state = loadUpdateState(this.stateDir);
    if (checked.available === undefined || compareVersions(checked.available, checked.current) <= 0) return { ok: true, message: `${checked.current} is the newest version` };
    if (checked.available === state.failed) return { ok: false, code: "failed_before", message: `${checked.available} failed its start check on this machine and is skipped` };
    return this.install(checked.available, false);
  }

  /** Installs `version` through TUF (or switches to the kept previous version when that is it). `explicit` is a person's `--pin`: it may go down. */
  async install(version: string, explicit: boolean): Promise<UpdateResult> {
    const blocked = this.guard();
    if (blocked !== undefined) return blocked;
    if (!isVersion(version)) return { ok: false, code: "bad_version", message: "a version looks like 1.2.3" };
    return this.withLock(() => this.installLocked(version, explicit), { ok: false, code: "busy", message: "another update is running" } as UpdateResult);
  }

  private async installLocked(version: string, explicit: boolean): Promise<UpdateResult> {
    if (!layoutIsSafe(this.stateDir)) return { ok: false, code: "unmanaged", message: "the versions or bin directory is not a real directory, so nothing is changed" };
    this.cleanupLocked();
    const from = linkedVersion(this.stateDir);
    if (from === undefined) return { ok: false, code: "unmanaged", message: "the stable link is missing" };
    if (version === from) return { ok: true, message: `already on ${version}`, version };
    if (!explicit && compareVersions(version, from) <= 0) return { ok: false, code: "downgrade", message: "an automatic update never goes to an older version" };
    let state = loadUpdateState(this.stateDir);
    if (state.damaged === true) return { ok: false, code: "state_damaged", message: "update.json is damaged, so nothing is changed" };
    const platform = releasePlatform(this.deps.host.platform, this.deps.host.arch);
    if (platform === undefined) return { ok: false, code: "no_platform", message: "there is no release for this platform" };

    const reuse = state.previous === version && versionInstalled(this.stateDir, version);
    let verified: { file: string; sha256: string } | undefined;
    if (!reuse) {
      if (!this.deps.tuf.configured) return { ok: false, code: "not_configured", message: "updates are not configured in this build" };
      const fetched = await this.deps.tuf.fetchTarget(`v${version}/fx-runner-${platform}`);
      if (!fetched.ok) return { ok: false, code: fetched.state === "refused" ? fetched.code : fetched.state, message: fetched.state === "paused" ? `updates paused: ${fetched.message.replace(/^updates paused: /, "")}` : fetched.message };
      verified = { file: fetched.file, sha256: fetched.sha256 };
    }

    state = { ...loadUpdateState(this.stateDir), applying: { version, from } };
    saveUpdateState(this.stateDir, state);
    const staging = path.join(versionsDir(this.stateDir), `.staging-${randomBytes(6).toString("hex")}`);
    const target = path.join(versionsDir(this.stateDir), version);
    const abandon = (reason: string, mark: boolean): UpdateResult => {
      rmSync(staging, { recursive: true, force: true });
      if (!reuse) rmSync(target, { recursive: true, force: true });
      const now = loadUpdateState(this.stateDir);
      delete now.applying;
      if (mark) now.failed = version;
      saveUpdateState(this.stateDir, now);
      return { ok: false, code: "start_check_failed", message: reason };
    };
    try {
      if (verified !== undefined) {
        mkdirSync(staging, { recursive: true, mode: 0o700 });
        const staged = path.join(staging, "fx-runner");
        copyFileSync(verified.file, staged, constants.COPYFILE_EXCL);
        chmodSync(staged, 0o755);
        if (sha256(staged) !== verified.sha256) return abandon("the staged file does not match the verified hash; nothing was changed", false);
        chmodSync(staging, 0o755);
        rmSync(target, { recursive: true, force: true });
        // The staged file is the only thing in the staging directory; moving the directory puts it at versions/<v>/fx-runner in one rename.
        renameSync(staging, target);
      }
      if (!(await this.startCheck(versionBinary(this.stateDir, version), version))) return abandon(`${version} did not pass its start check; ${from} stays in use`, true);
      switchLink(this.stateDir, version);
      if (!(await this.startCheck(stableBinary(this.stateDir), version))) {
        switchLink(this.stateDir, from);
        return abandon(`${version} failed its start check after the switch; rolled back to ${from}`, true);
      }
      const done = loadUpdateState(this.stateDir);
      delete done.applying;
      if (versionInstalled(this.stateDir, from)) done.previous = from;
      if (done.failed === version) delete done.failed;
      this.prune(done, version);
      saveUpdateState(this.stateDir, done);
      return { ok: true, message: `Updated to ${version}.`, version };
    } catch {
      // fx-swallow-ok: fail closed; the link is moved only after the checks, and the next run cleans partial directories. The error text may carry a path
      rmSync(staging, { recursive: true, force: true });
      if (linkedVersion(this.stateDir) !== version) return abandon("the update could not be applied; the current version stays in use", false);
      return { ok: false, code: "error", message: "the update stopped part-way; run: fx-runner update --rollback if the new version does not work" };
    } finally {
      if (verified !== undefined) rmSync(verified.file, { force: true });
    }
  }

  /** `--pin <v>`: hold that version, installing it (older ones included) when it is not the one in use. */
  async pin(version: string): Promise<UpdateResult> {
    if (!isVersion(version)) return { ok: false, code: "bad_version", message: "a version looks like 1.2.3" };
    const installed = await this.install(version, true);
    if (!installed.ok) return installed;
    const state = loadUpdateState(this.stateDir);
    if (state.damaged === true) return { ok: false, code: "state_damaged", message: "update.json is damaged; the pin was not recorded" };
    state.pinned = version;
    saveUpdateState(this.stateDir, state);
    return { ok: true, message: `Pinned to ${version}. Automatic updates hold it until: fx-runner update --unpin`, version };
  }

  unpin(): UpdateResult {
    const state = loadUpdateState(this.stateDir);
    if (state.damaged === true) return { ok: false, code: "state_damaged", message: "update.json is damaged; fix or remove it first" };
    delete state.pinned;
    saveUpdateState(this.stateDir, state);
    return { ok: true, message: "Unpinned." };
  }

  setAutoUpdate(on: boolean): UpdateResult {
    const state = loadUpdateState(this.stateDir);
    if (state.damaged === true) return { ok: false, code: "state_damaged", message: "update.json is damaged; fix or remove it first" };
    state.autoUpdate = on;
    saveUpdateState(this.stateDir, state);
    return { ok: true, message: `Automatic updates are ${on ? "on" : "off"}.` };
  }

  /** `--rollback`: back to the kept previous version, byte for byte (it is the same file, not a copy). */
  async rollback(): Promise<UpdateResult> {
    const blocked = this.guard();
    if (blocked !== undefined) return blocked;
    return this.withLock(async (): Promise<UpdateResult> => {
      if (!layoutIsSafe(this.stateDir)) return { ok: false, code: "unmanaged", message: "the versions or bin directory is not a real directory, so nothing is changed" };
      this.cleanupLocked();
      const state = loadUpdateState(this.stateDir);
      const from = linkedVersion(this.stateDir);
      if (state.damaged === true) return { ok: false, code: "state_damaged", message: "update.json is damaged, so nothing is changed" };
      const previous = state.previous;
      if (previous === undefined || from === undefined || !versionInstalled(this.stateDir, previous)) return { ok: false, code: "no_previous", message: "there is no previous version kept to roll back to" };
      if (!(await this.startCheck(versionBinary(this.stateDir, previous), previous))) return { ok: false, code: "start_check_failed", message: `${previous} did not pass its start check; ${from} stays in use` };
      switchLink(this.stateDir, previous);
      state.previous = from;
      state.failed = from;
      if (state.pinned === from) delete state.pinned;
      saveUpdateState(this.stateDir, state);
      return { ok: true, message: `Rolled back to ${previous}. Restart fx-runner run to use it.`, version: previous };
    }, { ok: false, code: "busy", message: "another update is running" });
  }
}

/** What the daemon asks between jobs. */
export interface AutoUpdateDeps {
  updater: Updater;
  /** True while a job is in hand. */
  hasLease: () => boolean;
  now: () => Date;
  intervalMs?: number;
}

export type AutoOutcome = { kind: "none" } | { kind: "checked"; message: string } | { kind: "applied"; version: string };

export function createAutoUpdate(deps: AutoUpdateDeps): { tick: () => Promise<AutoOutcome> } {
  const interval = deps.intervalMs ?? CHECK_INTERVAL_MS;
  return {
    async tick(): Promise<AutoOutcome> {
      if (deps.hasLease()) return { kind: "none" };
      const state = loadUpdateState(deps.updater.dir);
      if (!state.autoUpdate || state.damaged === true || state.pinned !== undefined) return { kind: "none" };
      if (deps.updater.kind() !== "managed" || !deps.updater.configured) return { kind: "none" };
      const last = state.lastCheck === undefined ? undefined : Date.parse(state.lastCheck);
      const now = deps.now().getTime();
      if (last !== undefined && now >= last && now - last < interval) return { kind: "none" };
      const result = await deps.updater.applyLatest();
      if (result.ok && result.version !== undefined) return { kind: "applied", version: result.version };
      return { kind: "checked", message: result.message };
    },
  };
}
