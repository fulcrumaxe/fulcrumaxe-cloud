/**
 * Nested `.git` entries in the worktree (D#6 RUNNER-HOSTREAD-FOLLOWUPS-527, F2).
 *
 * The daemon's own `git diff`, `git ls-files --others` and the resume clean-up's `--ignored` listing open whatever a nested `.git` leads to, in the daemon itself and
 * outside the sandbox. A `.git` FILE (`gitdir: <path>`) names another folder; a nested `.git` DIRECTORY can hold a `commondir`, an `include.path` in its config, a
 * `reftable/tables.list` with `../` names, links under `refs`, a loose ref that is `/dev/zero` or a FIFO (git reads it forever), a FIFO as `HEAD`. Nothing runs, but
 * the answers show in the listing (`dir/` against `dir/f`), in what is read, and in how long a read takes. Inspecting each shape one by one has not held, so a nested
 * `.git` is not inspected at all: before a worktree read the daemon walks the worktree and refuses (`workspace_git_refused`) when ANY entry named `.git` (or a name git reads as it, see `isDotGitName`) is found below
 * the workspace root, whatever it is (directory, file, link, FIFO, socket). A fresh clone has none, an initialised submodule is already refused by the `.git/modules`
 * check, and a repository the agent cloned inside the workspace is rare; that job ends with the plain not-run sentence.
 *
 * The walk goes into every real directory, ignored ones included (the resume listing stats `<ignored dir>/.git` and its `HEAD`), looking for the name `.git`; the
 * same entry cap bounds all of it. How it is bounded: it never follows a link (a symlinked directory, or a loop of them, is one counted entry and is not entered),
 * and stops at `MAX_ENTRIES` entries or `MAX_DEPTH` levels; past either it refuses, since it cannot show the tree clean. No file is opened or read.
 * Only reads that name worktree paths (`diff`, `status`, `ls-files`) walk; the ref-only reads (`for-each-ref`, `rev-parse`, `symbolic-ref`) touch no worktree path and never do.
 */
import { readdirSync, realpathSync } from "node:fs";
import { GitPathError } from "./git.js";

const MAX_ENTRIES = 400_000;
const MAX_DEPTH = 64;

/**
 * Whether a directory entry's name is one git reads as `.git`. Exact `.git` is not enough: on a case-insensitive filesystem (macOS APFS by default, Windows) `.GIT` and
 * `.Git` are the same entry, and git's own `is_hfs_dotgit` / `is_ntfs_dotgit` also accept the HFS+ ignorable code points inside the name (U+200C-U+200F, U+202A-U+202E,
 * U+206A-U+206F, U+FEFF), NTFS trailing dots and spaces, a trailing U+FFFE or U+FFFF (git refuses those under protectHFS), an NTFS stream suffix (`.git::$INDEX_ALLOCATION`) and the short name `git~1`. All of those are matched here,
 * case-insensitively, on every platform: refusing a name that a case-sensitive filesystem would not use as `.git` costs nothing.
 */
export function isDotGitName(name: string): boolean {
  const folded = name.replace(/[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g, "").toLowerCase();
  const base = folded.split(":")[0]!.replace(/[ .\ufffe\uffff]+$/, "");
  return base === ".git" || base === "git~1";
}

const refuse = (): never => {
  throw new GitPathError("workspace_git_refused");
};

/** Throws `workspace_git_refused` when anything named `.git` exists below the workspace root, or the worktree cannot be shown clean within the bounds. */
export function assertNoOutsideGitfiles(workspace: string): void {
  try {
    const root = realpathSync(workspace);
    const budget = { left: MAX_ENTRIES };
    const walk = (dir: string, depth: number): void => {
      if (depth > MAX_DEPTH) refuse();
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (--budget.left < 0) refuse();
        if (isDotGitName(entry.name)) {
          if (dir === root && entry.name === ".git") continue; // the outer folder: the shape check has it
          refuse();
        }
        if (entry.isDirectory()) walk(`${dir}/${entry.name}`, depth + 1); // a Dirent of a link is never `isDirectory()`
      }
    };
    walk(root, 0);
  } catch {
    // fx-swallow-ok: replaced by the closed code; a system error or helper code here carries a path
    refuse();
  }
}
