/**
 * The root side of `fx-runner vm uninstall` (D#587 B-2a-2 PR-4): applies the checked list of removals (./uninstallActions) one step at a time,
 * with the same path checks and the same programs-by-name door (`RootOps`) as the install side (./rootApply). It never undoes anything: a
 * removal that finds its target gone changes nothing and says so, so a run that was killed half-way converges when it is run again.
 *
 * Before the first step every target and each directory above it is judged (a link anywhere means no step runs, which is how a host whose
 * helper is managed declaratively is refused). Nothing is removed unless it is what install made. A file or directory whose owner or mode is
 * not the one install sets was changed by someone, so it is LEFT in place and reported by name; the run goes on with the rest. The group and
 * the runner's membership are removed only if install's own record says it made them. The sandbox data in the runner's `snapshot_dir` is not on
 * any list, so nothing here can reach it.
 */
import { lstatSync, readdirSync, rmdirSync, unlinkSync, type Stats } from "node:fs";
import path from "node:path";
import { CliError } from "../cliError.js";
import { LAYOUT } from "./installPlan.js";
import { NO_RECORD, type InstallRecord } from "./installRecord.js";
import { checkedLstat, ids, lookup, must, readTrustedRecord, sameMeta, symlinkRefusal, syncDir, type RootOps } from "./rootApply.js";
import { describeUninstall, uninstallPathActions, type UninstallAction, type UninstallRequest } from "./uninstallActions.js";

export interface UninstallReport {
  readonly ok: boolean;
  readonly done: readonly string[];
  readonly unchanged: readonly string[];
  /** Found, but not as install made it (or not empty, or not install's to remove): left in place, each with the reason. */
  readonly left: readonly string[];
  readonly failed?: string;
}

/** What the root side asks of the file system; a test replaces `lstat` to give an entry another owner or device, which needs root to make for real. */
export interface UninstallIo {
  lstat(file: string): Stats;
}
const REAL_IO: UninstallIo = { lstat: (f) => lstatSync(f) };

/** The first reason a tree may not be removed, or undefined. Every entry must be a plain file or directory of the expected owner that others cannot write, on the same device. */
function treeProblem(dir: string, top: Stats, uid: number, io: UninstallIo): string | undefined {
  for (const name of readdirSync(dir)) {
    const p = path.posix.join(dir, name);
    const st = io.lstat(p);
    if (st.isSymbolicLink() || !(st.isFile() || st.isDirectory())) return `${p} is not a plain file or directory`;
    if (st.uid !== uid || (st.mode & 0o022) !== 0 || st.dev !== top.dev) return `${p} has a different owner, is writable by others, or is on another device`;
    const inner = st.isDirectory() ? treeProblem(p, top, uid, io) : undefined;
    if (inner !== undefined) return inner;
  }
  return undefined;
}

function removeTree(dir: string): void {
  for (const name of readdirSync(dir)) {
    const p = path.posix.join(dir, name);
    if (lstatSync(p).isDirectory()) removeTree(p);
    else unlinkSync(p);
  }
  rmdirSync(dir);
}

type Outcome = { readonly kind: "done" } | { readonly kind: "unchanged" } | { readonly kind: "left"; readonly why: string };
const DONE: Outcome = { kind: "done" };
const SAME: Outcome = { kind: "unchanged" };
const CHANGED = (a: { owner: string; mode: string }): string => `its owner or mode is not what install sets (${a.owner} ${a.mode}); it was changed since, so check it and remove it by hand`;

async function removeFile(a: Extract<UninstallAction, { op: "remove-file" }>, ops: RootOps): Promise<Outcome> {
  const st = checkedLstat(a.path);
  if (st === undefined) return SAME;
  if (!st.isFile()) return { kind: "left", why: "it is not a regular file" };
  const { uid, gid } = await ids(ops, a.owner);
  if (!sameMeta(st, uid, gid, parseInt(a.mode, 8))) return { kind: "left", why: CHANGED(a) };
  unlinkSync(a.path);
  syncDir(path.posix.dirname(a.path));
  return DONE;
}

async function removeDir(a: Extract<UninstallAction, { op: "remove-dir" }>, ops: RootOps, io: UninstallIo): Promise<Outcome> {
  const st = checkedLstat(a.path);
  if (st === undefined) return SAME;
  if (!st.isDirectory()) return { kind: "left", why: "it is not a directory" };
  const { uid, gid } = await ids(ops, a.owner);
  if (!sameMeta(st, uid, gid, parseInt(a.mode, 8))) return { kind: "left", why: CHANGED(a) };
  if (a.tree === true) {
    const problem = treeProblem(a.path, st, uid, io);
    if (problem !== undefined) return { kind: "left", why: `${problem}; nothing in it was removed` };
    removeTree(a.path);
  } else {
    if (readdirSync(a.path).length > 0) return { kind: "left", why: "it is not empty" };
    rmdirSync(a.path);
  }
  syncDir(path.posix.dirname(a.path));
  return DONE;
}

interface State {
  record: InstallRecord;
}

/** Install's record, read before the first step (its own file is removed part-way down the list). Anything unreadable is "install recorded nothing". */
async function readRecord(actions: readonly UninstallAction[], ops: RootOps): Promise<InstallRecord> {
  const file = actions.find((a) => a.op === "remove-file" && path.posix.basename(a.path) === path.posix.basename(LAYOUT.recordFile));
  return file === undefined || file.op !== "remove-file" ? NO_RECORD : readTrustedRecord(ops, file.path);
}

const NOT_RECORDED = (what: string): Outcome => ({ kind: "left", why: `install did not record making ${what}, so it may have been there before; remove it by hand if it is yours` });

async function step(a: UninstallAction, ops: RootOps, st: State, io: UninstallIo): Promise<Outcome> {
  switch (a.op) {
    case "stop-disable": {
      const enabled = (await ops.run("systemctl", ["is-enabled", "--quiet", a.unit])).code === 0;
      const active = (await ops.run("systemctl", ["is-active", "--quiet", a.unit])).code === 0;
      if (!enabled && !active) return SAME;
      await must(ops, "systemctl", ["disable", "--now", a.unit]);
      return DONE;
    }
    case "remove-file":
      return removeFile(a, ops);
    case "remove-dir":
      return removeDir(a, ops, io);
    case "daemon-reload":
      // Always: it is idempotent, and a run killed between the unit's removal and this step must still reload on its re-run.
      await must(ops, "systemctl", ["daemon-reload"]);
      return DONE;
    case "remove-member": {
      const g = await lookup(ops, "group", a.group);
      if (g?.members.includes(a.user) !== true) return SAME;
      if (!st.record.members_added.includes(a.user)) return NOT_RECORDED(`${a.user} a member of ${a.group}`);
      await must(ops, "gpasswd", ["-d", a.user, a.group]);
      return DONE;
    }
    case "remove-group":
      if ((await lookup(ops, "group", a.name)) === undefined) return SAME;
      if (!st.record.group_created) return NOT_RECORDED(`the group ${a.name}`);
      await must(ops, "groupdel", ["--", a.name]);
      return DONE;
  }
}

/** Applies the request. A step that fails stops the run (nothing later is touched); a target that was changed is left and reported, and the run goes on. */
export async function applyUninstall(req: UninstallRequest, ops: RootOps, io: UninstallIo = REAL_IO): Promise<UninstallReport> {
  const done: string[] = [];
  const unchanged: string[] = [];
  const left: string[] = [];
  // Every target path and each directory above it is judged before the first change: a link anywhere on the way means no step runs.
  const linked = symlinkRefusal(uninstallPathActions(req.actions));
  if (linked !== undefined) return { ok: false, done, unchanged, left, failed: `refused: ${linked}; nothing was changed` };
  const st: State = { record: await readRecord(req.actions, ops) };
  for (const a of req.actions) {
    const label = describeUninstall(a);
    try {
      const r = await step(a, ops, st, io);
      if (r.kind === "done") done.push(label);
      else if (r.kind === "unchanged") unchanged.push(label);
      else left.push(`${"path" in a ? a.path : label}: ${r.why}`);
    } catch (e) {
      // fx-swallow-ok: the failure is reported in the returned report, by step name
      return { ok: false, done, unchanged, left, failed: `${label}: ${e instanceof CliError ? e.message : ((e as NodeJS.ErrnoException).code ?? "unexpected error")}` };
    }
  }
  return { ok: true, done, unchanged, left };
}
