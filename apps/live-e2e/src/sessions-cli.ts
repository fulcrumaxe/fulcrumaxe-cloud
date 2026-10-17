/**
 * The session commands (T3).
 *
 *   live-e2e capture-session --target <name> --role <role> [--live-user <unix user>]
 *   live-e2e sessions keep-alive --target <name> [--repo owner/name] [--run-url url] [--summary file]
 *   live-e2e sessions status --target <name>
 *   live-e2e sessions forget --target <name> --role <role>
 *
 * `capture-session` runs on the owner's machine: a headed browser in a fresh profile, the owner signs in by hand,
 * only the app cookie is kept, encrypted with LIVE_E2E_SESSION_KEY. With `--live-user` the file is written into
 * that user's home by commands that all run AS that user (`sudo -n -u <user> ...`, never as root, because the live
 * account controls every folder on that path and a root command would follow its links); without it the file is
 * written to the caller's own home.
 * `keep-alive` is what every scheduled run calls: one request per stored role, write-back, the 3-day warning and
 * the one lapse issue per role. Exit codes: 0 done, 1 a store, browser or GitHub failure, 2 usage.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Io } from "./cli.js";
import { GithubError, postTeamLog, syncSessionIssues, syncStoreIssue } from "./issues.js";
import { MASK_FILE_ENV, MaskRegistry } from "./mask.js";
import { BYPASS_ENV } from "./needs.js";
import { captureSession, isLapsed, keepAlive, sessionStatus } from "./sessions.js";
import { decryptRoles, encryptRoles, isRole, mergeNewest, parseKey, putRole, readStore, removeRole, roleAllowedOn, StoreError, storePath, type Roles } from "./store.js";
import { loadTarget, TargetError, type Target } from "./targets.js";

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}
/** Runs a program with an argument list (never a shell), `input` on its stdin. Test seam for the `sudo` calls. */
export type CommandRunner = (command: string, args: string[], input?: string) => CommandResult;

export const defaultRunner: CommandRunner = (command, args, input) => {
  const r = spawnSync(command, args, { encoding: "utf8", ...(input !== undefined ? { input } : {}) });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

const USER_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;

function flags(argv: string[], allowed: readonly string[]): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i] as string;
    const value = argv[i + 1];
    if (!allowed.includes(flag) || value === undefined || value.startsWith("--") || flag in out) return null;
    out[flag] = value;
  }
  return out;
}

/**
 * `announce` prints `::add-mask::` lines (right in a CI job, where the runner reads them; wrong at the owner's
 * terminal, where it would print the cookie into the scrollback).
 */
function registryFor(io: Io, announce: boolean): MaskRegistry {
  const file = io.env[MASK_FILE_ENV];
  return new MaskRegistry({ emit: announce ? (line) => io.stdout(line) : () => undefined, ...(file ? { file } : {}) });
}

const LOCK_STALE_S = 30;
const LOCK_WAIT_MS = 10_000;
const sleepSync = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** The one shell snippet run as the live user (a fixed string; the path is its argument `$1`, never spliced into it). */
const WRITE_STDIN = 'set -C; umask 077; cat > "$1"';
const missing = (r: CommandResult): boolean => /No such file/.test(r.stderr);

/** Every command on the live user's files runs as that user. There is no root step: the live account controls this whole path. */
const asUser =
  (user: string, run: CommandRunner) =>
  (argv: string[], input?: string): CommandResult =>
    run("sudo", ["-n", "-u", user, ...argv], input);

/**
 * Refuses a link or a non-folder at each level of the store's path (`.local`, `.local/state`, `live-e2e`), seen as the
 * live user. Nothing here could escalate (the commands run as that user), but a link would send the store, or the
 * mode change on the folder, somewhere the live user's own writers refuse to go, so it is refused here too. A level
 * that does not exist yet is fine: it is made next, as that user.
 */
function assertPlainRemote(user: string, file: string, run: CommandRunner): void {
  const dir = dirname(file);
  for (const level of [dirname(dirname(dir)), dirname(dir), dir]) {
    const st = asUser(user, run)(["stat", "-c", "%F", level]);
    if (st.status !== 0) {
      if (missing(st)) return; // nothing below a missing level exists either
      throw new StoreError(`cannot inspect the session store folder of ${user}`);
    }
    const kind = st.stdout.trim();
    if (kind === "symbolic link") throw new StoreError("the session store folder is a symbolic link");
    if (kind !== "directory") throw new StoreError("the session store folder is not a directory");
  }
}

/**
 * The owner's capture writes another user's store, so it takes the SAME lock the live user's own writers take: the
 * folder `<store>.lock`, made with `mkdir` as that user (atomic). A lock older than LOCK_STALE_S is reclaimed by one
 * waiter at a time, through `<lock>.reclaim`, after re-checking its age under that guard; a symlink is refused.
 * Every pass that did not take the lock checks the deadline and then sleeps, so no failure of `stat` or `sudo` can
 * spin: a `stat` that fails for any reason except "no such file" is an error at once.
 */
export function withRemoteLock<T>(user: string, file: string, run: CommandRunner, body: () => T, opts: { waitMs?: number } = {}): T {
  const as = asUser(user, run);
  const lock = `${file}.lock`;
  const guard = `${lock}.reclaim`;
  const ageS = (path: string): number | undefined => {
    const st = as(["stat", "-c", "%Y %F", path]);
    if (st.status !== 0) {
      if (missing(st)) return undefined;
      throw new StoreError(`cannot inspect the session store lock of ${user}`);
    }
    const [mtime, ...kind] = st.stdout.trim().split(" ");
    if (kind.join(" ") === "symbolic link") throw new StoreError("the session store lock is a symbolic link");
    return Date.now() / 1000 - Number(mtime);
  };
  // The lock folder lives beside the store, so the store folder has to exist before the first `mkdir` of the lock: on a
  // fresh live home it does not, and that `mkdir` would fail every pass until the wait ran out. Make it as the live
  // user (the same refusals of links as installAs), then look again.
  assertPlainRemote(user, file, run);
  if (as(["mkdir", "-p", "-m", "0700", dirname(file)]).status !== 0) throw new StoreError(`could not make the session store folder of ${user}`);
  assertPlainRemote(user, file, run);
  const deadline = Date.now() + (opts.waitMs ?? LOCK_WAIT_MS);
  for (;;) {
    if (as(["mkdir", "-m", "0700", lock]).status === 0) break;
    if (Date.now() > deadline) throw new StoreError(`the session store of ${user} is locked by another writer`);
    const age = ageS(lock);
    if (age !== undefined && age > LOCK_STALE_S) {
      if (as(["mkdir", "-m", "0700", guard]).status === 0) {
        try {
          const again = ageS(lock);
          if (again !== undefined && again > LOCK_STALE_S) as(["rm", "-rf", lock]);
        } finally {
          as(["rm", "-rf", guard]);
        }
      } else if ((ageS(guard) ?? 0) > LOCK_STALE_S) as(["rm", "-rf", guard]);
    }
    sleepSync(25);
  }
  try {
    return body();
  } finally {
    as(["rm", "-rf", lock]);
  }
}

function readAs(user: string, file: string, target: string, key: Buffer, run: CommandRunner): Roles {
  const cat = asUser(user, run)(["cat", file]);
  if (cat.status !== 0 && !missing(cat)) throw new StoreError(`cannot read the existing store as ${user}`);
  return cat.status === 0 ? decryptRoles(cat.stdout, target, key) : {};
}

/** `sudo` reads another user's store. Returns the existing roles and the file. */
function liveUserStore(user: string, target: string, key: Buffer, run: CommandRunner): { file: string; roles: Roles } {
  const passwd = run("getent", ["passwd", user]);
  const home = passwd.stdout.split(":")[5];
  if (passwd.status !== 0 || home === undefined || home === "") throw new StoreError(`no such user: ${user}`);
  const file = storePath(home, target);
  assertPlainRemote(user, file, run);
  return { file, roles: readAs(user, file, target, key, run) };
}

/**
 * Writes the ciphertext into the live user's store: the folder is made as that user, the ciphertext goes over stdin to
 * a temporary file made as that user (mode 0600, so no staged copy ever sits in the owner's temp folder), and
 * `mv -fT` renames it over the store, so a reader never sees half a file and a link at the store's place is replaced,
 * not followed.
 */
function installAs(user: string, file: string, ciphertext: string, run: CommandRunner): void {
  const as = asUser(user, run);
  const fail = (): never => {
    throw new StoreError(`could not install the store for ${user}`);
  };
  assertPlainRemote(user, file, run);
  if (as(["mkdir", "-p", "-m", "0700", dirname(file)]).status !== 0) fail();
  assertPlainRemote(user, file, run);
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  // `cat` from stdin under umask 077 and noclobber: mode 0600, and it refuses to write through anything already at `tmp`.
  if (as(["sh", "-c", WRITE_STDIN, "sh", tmp], ciphertext).status !== 0) {
    as(["rm", "-f", tmp]);
    fail();
  }
  if (as(["mv", "-fT", tmp, file]).status !== 0) {
    as(["rm", "-f", tmp]);
    fail();
  }
}

export async function captureCommand(argv: string[], io: Io): Promise<number> {
  const f = flags(argv, ["--target", "--role", "--live-user"]);
  if (f === null || f["--target"] === undefined || f["--role"] === undefined) {
    io.stderr("usage: live-e2e capture-session --target <name> --role <role> [--live-user <unix user>]");
    return 2;
  }
  try {
    const role = f["--role"];
    if (!isRole(role)) throw new StoreError(`"${role.slice(0, 32)}" is not a role`);
    const target = loadTarget(join(io.root, "targets"), f["--target"], io.env);
    if (!roleAllowedOn(role, target.name)) throw new StoreError(`the ${role} role is not used on ${target.name}`);
    const user = f["--live-user"];
    if (user !== undefined && !USER_PATTERN.test(user)) throw new StoreError("--live-user must be a plain user name");
    const key = parseKey(io.env["LIVE_E2E_SESSION_KEY"]);
    const run = io.run ?? defaultRunner;
    // Read the existing store BEFORE the browser opens: a rotated key, a corrupt file or an unreadable sudo target must
    // fail now, not after the owner has signed in by hand and the captured cookie has nowhere to go.
    const existing = user === undefined ? undefined : liveUserStore(user, target.name, key, run);
    const home = io.env["HOME"];
    if (user === undefined) {
      if (home === undefined) throw new StoreError("HOME is not set");
      readStore(storePath(home, target.name), target.name, key);
    }
    const cookie = await captureSession({
      target,
      bypassSecret: io.env[BYPASS_ENV],
      launcher: io.launcher ?? (await import("../fixtures/capture-browser.js")).chromiumLauncher,
      ...(io.headless === true ? { headless: true } : {}),
      ...(io.now !== undefined ? { now: io.now } : {}),
    });
    registryFor(io, false).register(cookie);
    if (user === undefined || existing === undefined) {
      await putRole(storePath(home as string, target.name), target.name, key, role, cookie);
    } else {
      const { file } = existing;
      // Under the live user's own lock, read the store as it is NOW and keep the newest cookie per role: a job may
      // have written back, or a keep-alive run, since the check before the browser opened.
      withRemoteLock(user, file, run, () => {
        const merged = mergeNewest(readAs(user, file, target.name, key, run), { [role]: cookie });
        installAs(user, file, encryptRoles(merged, target.name, key), run);
      });
    }
    io.stdout(`captured ${role} for ${target.name}; only the app cookie was kept`);
    return 0;
  } catch (err) {
    if (err instanceof StoreError || err instanceof TargetError) {
      io.stderr(err.message);
      return err instanceof TargetError ? 2 : 1;
    }
    io.stderr(`capture-session: ${err instanceof Error ? err.message : "failed"}`);
    return 1;
  }
}

function storeFor(io: Io, targetName: string): { target: Target; file: string; key: Buffer } {
  const target = loadTarget(join(io.root, "targets"), targetName, io.env);
  const home = io.env["HOME"];
  if (home === undefined) throw new StoreError("HOME is not set");
  return { target, file: storePath(home, target.name), key: parseKey(io.env["LIVE_E2E_SESSION_KEY"]) };
}

export async function sessionsCommand(argv: string[], io: Io): Promise<number> {
  const [sub, ...rest] = argv;
  const f = flags(rest, ["--target", "--role", "--repo", "--run-url", "--summary"]);
  if (f === null || f["--target"] === undefined || (sub !== "keep-alive" && sub !== "status" && sub !== "forget")) {
    io.stderr("usage: live-e2e sessions keep-alive|status|forget --target <name> [--role r] [--repo owner/name --run-url url] [--summary file]");
    return 2;
  }
  const now = (io.now ?? Date.now)();
  const summary = (text: string): void => {
    if (f["--summary"] !== undefined) appendFileSync(f["--summary"], `${text}\n\n`);
  };
  try {
    // A keep-alive with no key has nothing to keep alive: say so once and succeed (a missing key is not a run failure).
    if (sub === "keep-alive" && !io.env["LIVE_E2E_SESSION_KEY"]) {
      const text = "Session keep-alive skipped: LIVE_E2E_SESSION_KEY is not set in this environment; every session need is skipped.";
      io.stdout(text);
      summary(text);
      return 0;
    }
    const { target, file, key } = storeFor(io, f["--target"]);
    if (sub === "forget") {
      const role = f["--role"];
      if (role === undefined || !isRole(role)) throw new StoreError("forget needs --role <role>");
      await removeRole(file, target.name, key, role);
      io.stdout(`forgot ${role} for ${target.name}`);
      return 0;
    }
    const token = io.env["GITHUB_TOKEN"];
    const api = io.env["GITHUB_API_URL"];
    const gh =
      f["--repo"] !== undefined && token
        ? {
            repo: f["--repo"],
            token,
            ...(api ? { apiBase: api } : {}),
            ...(io.githubCa !== undefined ? { ca: io.githubCa } : {}),
            ...(f["--run-url"] !== undefined ? { runUrl: f["--run-url"] } : {}),
          }
        : undefined;
    const capture = (role: string): string => `live-e2e capture-session --target ${target.name} --role ${role} --live-user <the live-e2e runner user>`;
    let roles: Roles;
    try {
      roles = readStore(file, target.name, key);
    } catch (err) {
      // An unreadable store (a rotated key, an edited or corrupt file) is reported once with the way out, and is not a crash.
      if (sub !== "keep-alive" || !(err instanceof StoreError)) throw err;
      io.stdout(`session store unreadable: ${err.message}`);
      summary(`Session store unreadable: ${err.message}. Every session need is skipped until the roles are captured again (${capture("<role>")}).`);
      if (gh !== undefined) await syncStoreIssue(true, { ...gh, why: err.message, recapture: `Capture each role again: \`${capture("<role>")}\`. A rotated session key makes every stored session unreadable.` });
      return 0;
    }
    if (sub === "status") {
      for (const [role, cookie] of Object.entries(roles)) io.stdout(`${role}: ${sessionStatus(cookie, now).state}`);
      if (Object.keys(roles).length === 0) io.stdout("no stored sessions");
      return 0;
    }
    const reports = await keepAlive({ target, targetsDir: join(io.root, "targets"), env: io.env, file, key, roles, now, ...(io.fetch !== undefined ? { fetchImpl: io.fetch } : {}), mask: registryFor(io, true) });
    for (const r of reports) {
      io.stdout(`session ${r.role}: ${r.state}`);
      if (isLapsed(r.state)) summary(`Session lapsed (${r.role}): ${r.state}. Capture it again: ${capture(r.role)}`);
      if (r.state === "error") summary(`Session ${r.role}: the app could not be reached or answered unexpectedly; the stored session was left as it is.`);
      if (r.warnDaysLeft !== undefined) summary(`Session ${r.role} reaches its 30-day limit in ${r.warnDaysLeft} day(s); capture it again before then.`);
    }
    if (gh !== undefined) {
      await syncStoreIssue(false, { ...gh, why: "", recapture: "" });
      const actions = await syncSessionIssues(
        reports.filter((r) => r.state !== "error").map((r) => ({ role: r.role, state: r.state, lapsed: isLapsed(r.state) })),
        { ...gh, captureCommand: capture },
      );
      // A new lapse, or a changed reason, leaves one scrubbed team-log line. A lapse that is unchanged since the last
      // run (the keep-alive runs every few hours) adds nothing, as it adds nothing to the issue.
      const lapsed = actions.filter((a) => (a.action === "created" || a.action === "commented") && a.pack.startsWith("session:")).map((a) => a.pack);
      if (lapsed.length > 0) {
        await postTeamLog(
          { target: target.name, tier: "none", trigger: "keepalive", packs: lapsed, runUrl: gh.runUrl },
          { ...gh, scrub: { registry: registryFor(io, false), env: io.env }, ...(io.now !== undefined ? { now: io.now } : {}), summary },
        );
      }
    }
    return 0;
  } catch (err) {
    if (err instanceof StoreError) io.stderr(err.message);
    else if (err instanceof TargetError) io.stderr(err.message);
    else io.stderr(err instanceof GithubError ? err.message : "sessions: failed");
    return err instanceof TargetError || (err instanceof StoreError && /not set|usage|needs|must be/.test(err.message)) ? 2 : 1;
  }
}
