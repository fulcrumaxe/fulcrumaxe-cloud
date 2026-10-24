/**
 * D#6 RUNNER-RESUME-CLEAN: a fix round that resumes the kept workspace starts with the first round's ignored build output still in it
 * (an `apps/web/.next`, a `dist/`), and the check's guards then read stale generated files. Before a resumed run starts, this removes what git
 * itself reports as ignored, except the keep-list below. The list of what to remove is git's (`ls-files --others --ignored --exclude-standard
 * --directory`), not a hand-kept one; only what to KEEP is named.
 *
 * Kept: every `node_modules` at any depth, `.claude`, `.git`, the stub names the sandbox and the CLI place (`.env*`, `.npmrc`, `.idea`, ...: they
 * are ignored through the workspace's own exclude block, so git lists them), and any directory that holds one of those.
 * Untracked files that are NOT ignored are never listed by that command and are left alone: they may be the agent's own work.
 *
 * Deleting never follows a link: each entry is lstat'ed, a symlink is unlinked itself (never its target), and every entry's parent must resolve
 * (realpath) to a place under the workspace's own real path, or the entry is left. Nothing outside the workspace root is touched.
 * Failures leave the entry as it is. Nothing here reaches the cloud; the log lines hold counts only.
 *
 * Linux only (CWE-367). Node has no unlinkat, so between the parent check and the removal a live process could swap a directory for a link; the
 * check is `realpath(parent) === realRoot/dirname(rel)` exactly, which narrows that window but cannot close it. On Linux nothing of the previous run
 * can still be alive: the shell sandbox's bubblewrap runs with `--unshare-pid` and `--die-with-parent` (`sandbox/probe.ts`). On macOS (`sandbox-exec`,
 * no pid namespace) the engine's `stop` ends the agent's process group, but a process that called setsid leaves it and stays Seatbelt-confined to the
 * workspace. If it swapped an intermediate directory for a link, this unsandboxed runner's unlink would delete a file outside the workspace on that
 * process's behalf, so on darwin the clean-up is skipped entirely (one count-free log line), which is how a resume behaved before it existed.
 * Follow-up row RESUME-CLEAN-MAC: do the purge under sandbox-exec with a workspace-only write profile.
 *
 * The listing is read through the large capture where the caller has one. A listing that reached its cap is cleaned, then listed again (up to
 * MAX_PASSES) as long as a pass removed something; a listing still capped after that is reported by a count-only line.
 */
import { lstatSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { CLI_CWD_STUB_FILES, CLI_ENV_STUBS } from "./cliStubs.js";
import type { Git } from "./git.js";
import { isSandboxStubName } from "./sandboxStubs.js";
import { EXCLUDE_DIR_NAMES, EXCLUDE_FILE_NAMES } from "./workspaceExclude.js";

/** Names kept wherever they sit. */
const KEEP_ANYWHERE: ReadonlySet<string> = new Set(["node_modules", ".git", ".claude", ".venv", "CLAUDE.local.md", ".envrc"]);
/** Listing passes, at most, when the output keeps reaching the capture's cap. */
export const MAX_PASSES = 8;
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

/** Ignored entries git lists for `workspace`, as repository-relative paths (a trailing slash marks a whole ignored directory). */
async function ignoredEntries(git: Git, workspace: string, capChars: number): Promise<{ entries: string[]; capped: boolean }> {
  const out = await git.run("workspace_failed", ["-C", workspace, "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]);
  const parts = out.split("\0");
  const tail = parts.pop(); // after the last NUL: empty, or the cut-off tail of an output that hit the capture's limit
  return { entries: parts.filter((entry) => entry !== ""), capped: (tail ?? "") !== "" || out.length >= capChars };
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

/**
 * Removes the ignored build output from a resumed workspace and returns what was removed. A git that cannot list leaves the workspace unchanged.
 * Does nothing on darwin (see the header). `capChars` is the output limit of the capture `git` runs through. `log` gets a count-only line when anything was removed, and another when the
 * listing was still cut off after the last pass.
 */
export async function cleanResumedWorkspace(git: Git, workspace: string, log: ((line: string) => void) | undefined, capChars: number, platform: NodeJS.Platform): Promise<CleanCounts> {
  const counts: CleanCounts = { files: 0, dirs: 0 };
  if (platform === "darwin") {
    log?.("fx-runner: resume clean-up skipped on macOS");
    return counts;
  }
  let realRoot: string;
  try {
    realRoot = realpathSync(path.resolve(workspace));
  } catch {
    // fx-swallow-ok: this is a clean-up before a resumed run; a workspace that cannot be resolved is left as kept
    return counts;
  }
  let capped = false;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    let listing: { entries: string[]; capped: boolean };
    try {
      listing = await ignoredEntries(git, realRoot, capChars);
    } catch {
      // fx-swallow-ok: if git cannot answer, the run goes on with the workspace as kept
      break;
    }
    capped = listing.capped;
    const before = counts.files + counts.dirs;
    for (const entry of listing.entries) {
      const rel = entry.endsWith("/") ? entry.slice(0, -1) : entry;
      // Lexical containment: a listed path must stay below the root.
      if (rel === "" || path.isAbsolute(rel) || rel.split("/").some((part) => part === ".." || part === "" || part === ".")) continue;
      purge(realRoot, path.join(realRoot, rel), rel, counts);
    }
    // One pass is enough unless the listing was cut off and this pass made room (entries kept for good alone cannot make a second pass useful).
    if (!capped || counts.files + counts.dirs === before) break;
  }
  if (log !== undefined) {
    if (counts.files > 0 || counts.dirs > 0) log(`fx-runner: resumed workspace: removed ${counts.files} ignored files and ${counts.dirs} directories of build output`);
    if (capped) log("fx-runner: resumed workspace: the list of ignored files was cut off; some build output may remain");
  }
  return counts;
}
