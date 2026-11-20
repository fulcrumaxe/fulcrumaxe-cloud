/**
 * The root side of `fx-runner vm install` (D#587 B-2a-2 PR-3): applies a checked list of steps (./rootActions) one at a time and, if any
 * step fails, undoes the ones that changed something in reverse order. A step that finds its result already in place changes nothing and
 * is reported as unchanged, so a second run on an installed host does nothing and says so.
 *
 * Every path is absolute and refused if it, or any directory above it, is a symlink. A file is written to a temp file in its own directory
 * (exclusive, no-follow), fsynced, renamed over the target, and only then are its owner, mode and content checked again. Programs
 * (groupadd, usermod, systemctl, getent) and the socket probe come in through `RootOps`, so nothing here starts a process.
 */
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, fchownSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeSync, type Stats } from "node:fs";
import path from "node:path";
import { CliError } from "../cliError.js";
import type { RootAction, RootRequest } from "./rootActions.js";
import { UNIT_NAME, describeAction } from "./rootActions.js";

/** The two calls whose failure leaves temp and backup files to clean up. Tests replace them to make them fail; nothing else does. */
export const fsCalls = { link: linkSync, rename: renameSync };

export interface RootOps {
  run(file: string, args: readonly string[]): Promise<{ readonly code: number | null; readonly output: string }>;
  probe(socket: string): Promise<boolean>;
}

export interface RootReport {
  readonly ok: boolean;
  readonly done: readonly string[];
  readonly unchanged: readonly string[];
  readonly undone: readonly string[];
  readonly undoFailed: readonly string[];
  readonly failed?: string;
}

/** How to put a step back, and (for a replaced file) how to drop the saved old copy once the whole install has succeeded. */
type Undo = (() => Promise<void> | void) & { commit?: () => void };

const fail = (why: string): never => {
  throw new CliError(why);
};
const sha256Of = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

/** Refuses a path that is not clean and absolute, or whose own name or any directory above it is a symlink or not a directory. Returns the target's stat, or undefined if it does not exist. */
function checkedLstat(target: string): Stats | undefined {
  if (!target.startsWith("/") || target.includes("\0") || path.posix.normalize(target) !== target) fail(`refused: ${target} is not a clean absolute path`);
  let dir = "/";
  const parts = target.split("/").filter((p) => p !== "");
  for (const [i, part] of parts.entries()) {
    dir = path.posix.join(dir, part);
    let st: Stats;
    try {
      st = lstatSync(dir);
    } catch (e) {
      // fx-swallow-ok: a missing last component is the answer "does not exist"; anything else is refused by name below
      if ((e as NodeJS.ErrnoException).code === "ENOENT" && i === parts.length - 1) return undefined;
      return fail(`refused: ${dir} cannot be examined`);
    }
    if (st.isSymbolicLink()) fail(`refused: ${dir} is a symlink`);
    if (i < parts.length - 1 && !st.isDirectory()) fail(`refused: ${dir} is not a directory`);
    if (i === parts.length - 1) return st;
  }
  return undefined;
}

async function lookup(ops: RootOps, db: "passwd" | "group", name: string): Promise<{ id: number; gid: number; members: string[] } | undefined> {
  const r = await ops.run("getent", [db, name]);
  if (r.code !== 0) return undefined;
  const f = r.output.trim().split("\n")[0]!.split(":");
  const id = Number(f[2]);
  if (!Number.isInteger(id)) return fail(`refused: the ${db} entry for ${name} is malformed`);
  return db === "passwd" ? { id, gid: Number(f[3]), members: [] } : { id, gid: id, members: (f[3] ?? "").split(",").filter((m) => m !== "") };
}

async function ids(ops: RootOps, owner: string): Promise<{ uid: number; gid: number }> {
  const [user, group] = owner.split(":") as [string, string];
  const u = await lookup(ops, "passwd", user);
  const g = await lookup(ops, "group", group);
  if (u === undefined || g === undefined) return fail(`refused: owner ${owner} does not exist on this machine`);
  return { uid: u.id, gid: g.id };
}

const sameMeta = (st: Stats, uid: number, gid: number, mode: number): boolean => st.uid === uid && st.gid === gid && (st.mode & 0o7777) === mode;

function syncDir(dir: string): void {
  const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function openNoFollow(file: string, flags: number, mode?: number): number {
  return openSync(file, flags | constants.O_NOFOLLOW, mode);
}

/** The bytes a step installs. A staged file must be a regular file owned by the invoking user; its hash and length must be the signed ones. */
function contentOf(a: Extract<RootAction, { op: "install" }>, runnerUid: number): Buffer {
  let bytes: Buffer;
  if (a.text !== undefined) bytes = Buffer.from(a.text);
  else {
    // O_NONBLOCK and O_NOCTTY: a swapped-in FIFO or terminal device must not hang or take over the root process before it is judged
    const fd = openNoFollow(a.source!, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY);
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1) fail(`refused: the staged file for ${a.path} is not a plain file with one link`);
      if (st.uid !== runnerUid) fail(`refused: the staged file for ${a.path} is not owned by the invoking user`);
      bytes = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  if (bytes.length !== a.length || sha256Of(bytes) !== a.sha256) fail(`refused: the content for ${a.path} does not match its hash`);
  return bytes;
}

async function installFile(a: Extract<RootAction, { op: "install" }>, req: RootRequest, ops: RootOps): Promise<Undo | undefined> {
  const bytes = contentOf(a, req.runnerUid);
  const { uid, gid } = await ids(ops, a.owner);
  const mode = parseInt(a.mode, 8);
  const before = checkedLstat(a.path);
  if (before !== undefined) {
    if (!before.isFile()) fail(`refused: ${a.path} exists and is not a regular file`);
    if (sameMeta(before, uid, gid, mode) && sha256Of(readNoFollowFile(a.path)) === a.sha256) return undefined;
  }
  const dir = path.posix.dirname(a.path);
  const tmp = path.posix.join(dir, `.fx-tmp-${randomBytes(8).toString("hex")}`);
  const backup = path.posix.join(dir, `.fx-old-${randomBytes(8).toString("hex")}`);
  const fd = openNoFollow(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    let at = 0;
    while (at < bytes.length) at += writeSync(fd, bytes, at);
    fchownSync(fd, uid, gid);
    fchmodSync(fd, mode);
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    unlinkSync(tmp);
    throw e;
  }
  closeSync(fd);
  // The old file stays reachable under a second name until the install is committed, so an undo can put it back.
  let linked = false;
  try {
    if (before !== undefined) {
      fsCalls.link(a.path, backup);
      linked = true;
    }
    fsCalls.rename(tmp, a.path);
  } catch (e) {
    unlinkSync(tmp);
    if (linked) unlinkSync(backup);
    throw e;
  }
  const undo: Undo = () => {
    if (before !== undefined) renameSync(backup, a.path);
    else unlinkSync(a.path);
    syncDir(dir);
  };
  try {
    syncDir(dir);
    const after = checkedLstat(a.path);
    if (after === undefined || !after.isFile() || !sameMeta(after, uid, gid, mode)) fail(`${a.path} was installed but its owner or mode is not as stated`);
    if (sha256Of(readNoFollowFile(a.path)) !== a.sha256) fail(`${a.path} was installed but its content is not as stated`);
  } catch (e) {
    await undo();
    throw e;
  }
  return Object.assign(() => undo(), { commit: () => (before === undefined ? undefined : unlinkSync(backup)) });
}

function readNoFollowFile(file: string): Buffer {
  const fd = openNoFollow(file, constants.O_RDONLY);
  try {
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

async function makeDir(a: Extract<RootAction, { op: "mkdir" }>, ops: RootOps): Promise<Undo | undefined> {
  const { uid, gid } = await ids(ops, a.owner);
  const mode = parseInt(a.mode, 8);
  const before = checkedLstat(a.path);
  if (before !== undefined) {
    if (!before.isDirectory()) fail(`refused: ${a.path} exists and is not a directory`);
    if (sameMeta(before, uid, gid, mode)) return undefined;
    return fail(`refused: ${a.path} exists with a different owner or mode; fix or remove it first`);
  }
  mkdirSync(a.path, 0o700);
  const undo: Undo = () => rmdirSync(a.path);
  try {
    const fd = openNoFollow(a.path, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      fchownSync(fd, uid, gid);
      fchmodSync(fd, mode);
    } finally {
      closeSync(fd);
    }
    const after = checkedLstat(a.path);
    if (after === undefined || !after.isDirectory() || !sameMeta(after, uid, gid, mode)) fail(`${a.path} was made but its owner or mode is not as stated`);
  } catch (e) {
    await undo();
    throw e;
  }
  return undo;
}

async function must(ops: RootOps, file: string, args: readonly string[]): Promise<void> {
  const r = await ops.run(file, args);
  if (r.code !== 0) fail(`${file} ${args[0] ?? ""} failed`);
}

/** Runs one step. Returns how to undo it, or undefined when it found everything in place and changed nothing. */
/** What earlier steps of this run did, which later steps depend on. */
interface RunState {
  unitChanged: boolean;
  /** The helper, its config or its unit was replaced in this run. */
  programChanged: boolean;
  /** The service was running when this run reached it. */
  wasActive: boolean;
  /** A restart was begun, so a rollback must restart again once the old files are back. */
  restartBegun: boolean;
}

async function step(a: RootAction, req: RootRequest, ops: RootOps, st: RunState): Promise<Undo | undefined> {
  switch (a.op) {
    case "group": {
      if ((await lookup(ops, "group", a.name)) !== undefined) return undefined;
      await must(ops, "groupadd", ["--system", "--", a.name]);
      return () => must(ops, "groupdel", [a.name]);
    }
    case "member": {
      const g = await lookup(ops, "group", a.group);
      if (g?.members.includes(a.user) === true) return undefined;
      await must(ops, "usermod", ["-aG", a.group, "--", a.user]);
      return () => must(ops, "gpasswd", ["-d", a.user, a.group]);
    }
    case "mkdir":
      return makeDir(a, ops);
    case "install":
      return installFile(a, req, ops);
    case "daemon-reload":
      // Only when this run changed the unit file; on an installed host it is not a step at all.
      if (!st.unitChanged) return undefined;
      await must(ops, "systemctl", ["daemon-reload"]);
      // no undo of its own: it would run before the old unit file is back; a rollback reloads once, after the files are restored
      return () => undefined;
    case "enable-start": {
      const enabled = (await ops.run("systemctl", ["is-enabled", "--quiet", a.unit])).code === 0;
      const active = (await ops.run("systemctl", ["is-active", "--quiet", a.unit])).code === 0;
      st.wasActive = active;
      if (enabled && active) return undefined;
      await must(ops, "systemctl", ["enable", "--now", a.unit]);
      // put back only what this run changed: stop it if it was not running, disable it if it was not enabled
      return async () => {
        if (!active) await must(ops, "systemctl", ["stop", a.unit]);
        if (!enabled) await must(ops, "systemctl", ["disable", a.unit]);
      };
    }
    case "restart": {
      if (!st.programChanged || !st.wasActive) return undefined;
      st.restartBegun = true;
      await must(ops, "systemctl", ["restart", a.unit]);
      // nothing to undo of its own: a rollback restores the files and then restarts once more (see applyRootActions)
      return () => undefined;
    }
    case "probe":
      if (!(await ops.probe(a.socket))) fail(`the helper did not answer on ${a.socket}`);
      return undefined;
  }
}

/** The first target path that is, or lies below, a symlink or a non-directory (a missing component ends the walk: it will be made under the part already judged). */
export function symlinkRefusal(actions: readonly RootAction[], fsRoot = ""): string | undefined {
  for (const a of actions) {
    if (a.op !== "mkdir" && a.op !== "install") continue;
    let dir = "";
    const parts = a.path.split("/").filter((p) => p !== "");
    for (const [i, part] of parts.entries()) {
      dir = `${dir}/${part}`;
      let st: Stats;
      try {
        st = lstatSync(fsRoot + dir);
      } catch {
        // fx-swallow-ok: a component that does not exist ends the walk; it is made later under what was already judged
        break;
      }
      if (st.isSymbolicLink()) return `${dir} is a symlink`;
      if (i < parts.length - 1 && !st.isDirectory()) return `${dir} is not a directory`;
    }
  }
  return undefined;
}

/** What the user side checks before it asks for root: a NixOS machine, or a link on the way to a target, is configured declaratively and is refused with one sentence. */
export function hostRefusal(actions: readonly RootAction[], fsRoot = ""): string | undefined {
  let why: string | undefined;
  try {
    lstatSync(`${fsRoot}/etc/NIXOS`);
    why = "this is a NixOS machine";
  } catch {
    // fx-swallow-ok: no /etc/NIXOS means this is not NixOS
    why = symlinkRefusal(actions, fsRoot);
  }
  return why === undefined ? undefined : `vm install cannot run here (${why}); use the NixOS module services.fx-vmhelper instead.`;
}

/** Applies the request. Never throws for a step failure: the report says what was done, what was undone and what failed. */
export async function applyRootActions(req: RootRequest, ops: RootOps): Promise<RootReport> {
  const done: Array<{ label: string; undo: Undo }> = [];
  const unchanged: string[] = [];
  const st: RunState = { unitChanged: false, programChanged: false, wasActive: false, restartBegun: false };
  // Every staged file is judged before the first change: a file swapped after staging means no step runs at all. Each is read again,
  // through a fresh no-follow open and the same checks, when its own step runs, and what is written is exactly the bytes that passed.
  for (const a of req.actions) {
    if (a.op !== "install" || a.source === undefined) continue;
    try {
      contentOf(a, req.runnerUid);
    } catch (e) {
      // fx-swallow-ok: the refusal is reported in the returned report, by step name
      return { ok: false, done: [], unchanged: [], undone: [], undoFailed: [], failed: `${describeAction(a)}: ${e instanceof CliError ? e.message : ((e as NodeJS.ErrnoException).code ?? "unexpected error")}` };
    }
  }
  // Every target path and each directory above it is judged before the first change, the same way: a link anywhere on the way means no step runs.
  const linked = symlinkRefusal(req.actions);
  if (linked !== undefined) return { ok: false, done: [], unchanged: [], undone: [], undoFailed: [], failed: `refused: ${linked}` };
  for (const a of req.actions) {
    const label = describeAction(a);
    try {
      const undo = await step(a, req, ops, st);
      // the probe is a check, not a change: it is in neither list
      if (undo === undefined) {
        if (a.op !== "probe") unchanged.push(label);
      }
      else done.push({ label, undo });
      if (undo !== undefined && a.op === "install") {
        if (a.reloads === true) st.unitChanged = true;
        if (a.restarts === true) st.programChanged = true;
      }
    } catch (e) {
      const why = e instanceof CliError ? e.message : (e as NodeJS.ErrnoException).code ?? "unexpected error";
      const undone: string[] = [];
      const undoFailed: string[] = [];
      const doneLabels = done.map((d) => d.label);
      for (const d of [...done].reverse()) {
        try {
          await d.undo();
          undone.push(d.label);
        } catch {
          // fx-swallow-ok: the rollback goes on with the next step; this one is reported by name in undoFailed
          undoFailed.push(d.label);
        }
      }
      // the old files are back: reload systemd once if this run had changed the unit file, then (for an upgrade) start the old program again
      if (st.unitChanged) {
        const reload = "systemctl daemon-reload, with the old unit file back";
        try {
          await must(ops, "systemctl", ["daemon-reload"]);
          undone.push(reload);
        } catch {
          // fx-swallow-ok: reported by name in undoFailed
          undoFailed.push(reload);
        }
      }
      if (st.restartBegun) {
        const again = "systemctl restart again, with the old files back";
        try {
          await must(ops, "systemctl", ["restart", UNIT_NAME]);
          undone.push(again);
        } catch {
          // fx-swallow-ok: reported by name in undoFailed
          undoFailed.push(again);
        }
      }
      return { ok: false, done: doneLabels, unchanged, undone, undoFailed, failed: `${label}: ${why}` };
    }
  }
  for (const d of done) d.undo.commit?.();
  return { ok: true, done: done.map((d) => d.label), unchanged, undone: [], undoFailed: [] };
}
