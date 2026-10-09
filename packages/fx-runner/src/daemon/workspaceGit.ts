/**
 * Git path B, what the daemon trusts of a workspace before it reads it (D#6 R4a-3). The workspace's `.git` is written by the agent, and
 * the daemon reads it outside the sandbox with the user's credentials around. Git follows a `.git` file (`gitdir:`), a `.git` symlink,
 * `commondir`, a symlinked `objects`, `refs` or `HEAD`, and `objects/info/alternates`, to another repository on the machine; a fetch
 * would then bring that repository's history into the mirror and the push would publish it. So the daemon only fetches from a git
 * directory that is exactly what `git clone --reference <mirror>` makes, and nothing here follows a link.
 *
 * Every refusal is a closed code, `push_ref_refused` or (for the sandbox's own entries in `.git`, see below) `workspace_git_refused`; no
 * path or file content is put in an error.
 *
 * D#6 R4d-2 (C32 section 2): the Claude Code shell sandbox makes empty mount points inside `.git` (`commondir`, `config.worktree`,
 * `modules`, `worktrees`, `glab-cli`) before the agent's first command. The workspace check accepts exactly those shapes
 * (`sandboxStubs.ts`) and nothing looser; the snapshot, which the fetch actually reads, never holds them and still refuses a `commondir`.
 */
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import { GitPathError } from "./git.js";
import { STUB_COMMONDIR_CONTENTS, STUB_COMMONDIR_MAX_BYTES, STUB_EMPTY_DIRS, STUB_EMPTY_FILE } from "./sandboxStubs.js";

type Kind = "none" | "file" | "dir" | "link" | "other";

function kindOf(target: string): Kind {
  try {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) return "link";
    if (stat.isDirectory()) return "dir";
    return stat.isFile() ? "file" : "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "none";
    // fx-swallow-ok: replaced by the closed code; the system error carries a path
    throw new GitPathError("push_ref_refused");
  }
}

const refuse = (): never => {
  throw new GitPathError("push_ref_refused");
};

/** The most entries walked under `refs` and `objects`. A workspace borrows the mirror's objects, so its own stay small. */
const MAX_ENTRIES = 100_000;
/** `objects/info/alternates` is one short line. */
const MAX_ALTERNATES_BYTES = 4096;

/**
 * Reads a small file of the workspace without ever waiting on it: no-follow, non-blocking open (a FIFO swapped in after the lstat would
 * block a plain read forever), then the opened descriptor itself must be a regular file no larger than `cap`. Refuses otherwise,
 * with the one closed code, and never lets a raw open error (which names the path) out.
 */
export function readSmallRegular(file: string, cap: number): string {
  let fd: number;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch {
    // fx-swallow-ok: replaced by the closed code; the raw open error (ELOOP, ENOENT, ...) carries the path
    return refuse();
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > cap) return refuse();
    const buffer = Buffer.alloc(cap + 1);
    let length = 0;
    for (;;) {
      const read = readSync(fd, buffer, length, cap + 1 - length, null);
      if (read === 0) break;
      length += read;
      if (length > cap) return refuse();
    }
    return buffer.toString("utf8", 0, length);
  } finally {
    closeSync(fd);
  }
}

/** Refuses a link, or an entry that is neither a file nor a directory, anywhere under `dir`. */
function assertPlainTree(dir: string, budget: { left: number }): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (--budget.left < 0 || entry.isSymbolicLink() || !(entry.isFile() || entry.isDirectory())) refuse();
    if (entry.isDirectory()) assertPlainTree(path.join(dir, entry.name), budget);
  }
}

function realOrSelf(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    // fx-swallow-ok: a path that does not exist compares as written
    return value;
  }
}
const same = (a: string, b: string): boolean => a === b || realOrSelf(a) === realOrSelf(b);

/** Runs `step`, turning any system error (which would carry a path) into the closed code. */
function closed<T>(step: () => T): T {
  try {
    return step();
  } catch (error) {
    if (error instanceof GitPathError) throw error;
    // fx-swallow-ok: replaced by the closed code; the system error carries a path
    return refuse();
  }
}

const refuseWorkspace = (): never => {
  throw new GitPathError("workspace_git_refused");
};

/** Accepts the sandbox's entries inside `.git` in the exact shapes it makes, and refuses every other shape of them with `workspace_git_refused`. */
function assertSandboxStubs(gitDir: string): void {
  try {
    const commondir = path.join(gitDir, "commondir");
    if (kindOf(commondir) !== "none") {
      const stat = lstatSync(commondir);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > STUB_COMMONDIR_MAX_BYTES) refuseWorkspace();
      if (!STUB_COMMONDIR_CONTENTS.has(readSmallRegular(commondir, STUB_COMMONDIR_MAX_BYTES))) refuseWorkspace();
    }
    const emptyFile = path.join(gitDir, STUB_EMPTY_FILE);
    if (kindOf(emptyFile) !== "none") {
      const stat = lstatSync(emptyFile);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== 0) refuseWorkspace();
    }
    for (const name of STUB_EMPTY_DIRS) {
      const dir = path.join(gitDir, name);
      const kind = kindOf(dir);
      if (kind === "none") continue;
      if (kind !== "dir" || readdirSync(dir).length !== 0) refuseWorkspace();
    }
  } catch {
    // fx-swallow-ok: replaced by the closed code; a system error (or a helper's code) here is a shape the sandbox does not make
    refuseWorkspace();
  }
}

/**
 * Throws `push_ref_refused` unless `<workspace>/.git` is a real directory of the shape `git clone --reference` makes:
 * no `commondir` (other than the sandbox's empty one), no link at `HEAD`, `config`, `packed-refs`, `refs` or `objects` or anywhere inside the last two, and
 * `objects/info/alternates` absent or naming exactly `mirrorObjects` and nothing else. Returns the git directory to fetch from.
 */
export function assertWorkspaceGit(workspace: string, mirrorObjects: string): string {
  if (!path.isAbsolute(workspace) || !path.isAbsolute(mirrorObjects)) return refuse();
  const gitDir = path.join(workspace, ".git");
  if (kindOf(gitDir) !== "dir") refuse();
  assertGitDirShape(gitDir, mirrorObjects, false, true);
  return gitDir;
}

/**
 * The shape check on its own, for a git directory already known to be a real directory. It also runs on the daemon's snapshot
 * before the fetch (`requireAlternates`: the daemon wrote that line, so it must be there). It refuses a `.git` entry inside the
 * directory, which a non-strict `upload-pack` would try before the directory itself, and an alternates line that is not absolute.
 */
export function assertGitDirShape(gitDir: string, mirrorObjects: string, requireAlternates: boolean, tolerateSandboxStubs = false): void {
  if (!path.isAbsolute(gitDir) || !path.isAbsolute(mirrorObjects)) return refuse();
  if (kindOf(path.join(gitDir, ".git")) !== "none") refuse();
  if (tolerateSandboxStubs) assertSandboxStubs(gitDir);
  else if (kindOf(path.join(gitDir, "commondir")) !== "none") refuse();
  if (kindOf(path.join(gitDir, "HEAD")) !== "file") refuse();
  if (!["file", "none"].includes(kindOf(path.join(gitDir, "config")))) refuse();
  if (!["file", "none"].includes(kindOf(path.join(gitDir, "packed-refs")))) refuse();
  const refs = path.join(gitDir, "refs");
  const objects = path.join(gitDir, "objects");
  if (kindOf(refs) !== "dir" || kindOf(objects) !== "dir") refuse();
  const info = path.join(objects, "info");
  if (!["dir", "none"].includes(kindOf(info))) refuse();
  const budget = { left: MAX_ENTRIES };
  closed(() => assertPlainTree(refs, budget));
  closed(() => assertPlainTree(objects, budget));
  const alternates = path.join(info, "alternates");
  const kind = kindOf(alternates);
  if (kind === "none") {
    if (requireAlternates) refuse();
    return;
  }
  if (kind !== "file") refuse();
  const lines = closed(() => {
    const text = readSmallRegular(alternates, MAX_ALTERNATES_BYTES);
    return text.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  });
  // Git reads a relative line against `objects/`, not the daemon's directory, so only an absolute line is ever compared.
  if (lines.length !== 1 || !path.isAbsolute(lines[0]!) || !same(lines[0]!, mirrorObjects)) refuse();
}
