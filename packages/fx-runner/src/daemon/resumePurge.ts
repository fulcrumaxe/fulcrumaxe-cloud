/**
 * D#6 RUNNER-RESUME-CLEAN(-MAC): the removal half of the resumed-workspace clean-up, shared by the runner itself (Linux) and by the child it starts
 * under `sandbox-exec` (macOS, `commands/purgeChild.ts`). Both get a list of repository-relative paths git called ignored and run the same checks.
 *
 * Kept: every `node_modules` at any depth, `.claude`, `.git`, the stub names the sandbox and the CLI place (`.env*`, `.npmrc`, `.idea`, ...), and
 * any directory that holds one of those. Deleting never follows a link: each entry is lstat'ed, a symlink is unlinked itself (never its target), and
 * every entry's parent must resolve (realpath) to exactly the lexical parent under the workspace's real root, or the entry is left. Failures leave the
 * entry as it is. Nothing here reaches the cloud, and nothing here logs.
 *
 * Node has no unlinkat, so between the parent check and the removal a live process could swap a directory for a link (CWE-367). The in-process use
 * is therefore Linux only, where nothing of the previous run can still be alive; macOS runs this in a child whose Seatbelt profile allows writes
 * under the workspace only, so the kernel refuses a redirected unlink (`resumePurgeSandbox.ts`).
 */
import { lstatSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { CLI_CWD_STUB_FILES, CLI_ENV_STUBS } from "./cliStubs.js";
import { isSandboxStubName } from "./sandboxStubs.js";
import { EXCLUDE_DIR_NAMES, EXCLUDE_FILE_NAMES } from "./workspaceExclude.js";

/** Names kept wherever they sit. */
const KEEP_ANYWHERE: ReadonlySet<string> = new Set(["node_modules", ".git", ".claude", ".venv", "CLAUDE.local.md", ".envrc"]);
/** Root-level names kept (with everything below a directory). */
const KEEP_ROOT: ReadonlySet<string> = new Set([...EXCLUDE_FILE_NAMES, ...EXCLUDE_DIR_NAMES, ...CLI_CWD_STUB_FILES, ...CLI_ENV_STUBS]);

const kept = (rel: string): boolean => {
  const parts = rel.split("/");
  return parts.some((part) => KEEP_ANYWHERE.has(part)) || KEEP_ROOT.has(parts[0]!) || isSandboxStubName(rel);
};

export interface CleanCounts {
  files: number;
  dirs: number;
}

/** True when `dir` (the parent of an entry) is a real place under the workspace's real root. */
function parentInside(realRoot: string, dir: string, rel: string): boolean {
  try {
    // Exactly the lexical parent under the real root: a parent that is a link is refused, even one that points inside the workspace.
    return realpathSync(dir) === path.join(realRoot, path.dirname(rel));
  } catch {
    // fx-swallow-ok: a parent that cannot be resolved is not trusted; the entry stays
    return false;
  }
}

function hasGitChild(dir: string): boolean {
  try {
    lstatSync(path.join(dir, ".git"));
    return true;
  } catch {
    // fx-swallow-ok: no .git child
    return false;
  }
}

function purge(realRoot: string, abs: string, rel: string, counts: CleanCounts): void {
  if (kept(rel) || !parentInside(realRoot, path.dirname(abs), rel)) return;
  let isDir: boolean;
  try {
    isDir = lstatSync(abs).isDirectory(); // lstat: a link is not a directory here
  } catch {
    // fx-swallow-ok: already gone
    return;
  }
  try {
    // A nested repository (a `.git` child) is kept whole: its uncommitted work is not build output.
    if (isDir && hasGitChild(abs)) return;
    if (!isDir) {
      unlinkSync(abs); // a symlink is removed itself, whatever it points at
      counts.files += 1;
      return;
    }
    for (const name of readdirSync(abs)) purge(realRoot, path.join(abs, name), `${rel}/${name}`, counts);
    rmdirSync(abs); // fails, and the directory stays, while something kept is inside
    counts.dirs += 1;
  } catch {
    // fx-swallow-ok: a directory that still holds kept entries (or any failure) stays as it is
  }
}

/** The entry as a relative path (a trailing slash marks a whole ignored directory), or undefined when it could leave the root: lexical containment. */
export function relOf(entry: string): string | undefined {
  const rel = entry.endsWith("/") ? entry.slice(0, -1) : entry;
  return rel === "" || path.isAbsolute(rel) || rel.split("/").some((part) => part === ".." || part === "" || part === ".") ? undefined : rel;
}

/** Purges the listed entries below `realRoot` (already a real path) and returns what was removed. */
export function purgeListed(realRoot: string, entries: readonly string[]): CleanCounts {
  const counts: CleanCounts = { files: 0, dirs: 0 };
  for (const entry of entries) {
    const rel = relOf(entry);
    if (rel !== undefined) purge(realRoot, path.join(realRoot, rel), rel, counts);
  }
  return counts;
}
