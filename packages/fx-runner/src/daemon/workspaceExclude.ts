/**
 * Keeps the sandbox's stub files out of a workspace's `git add -A` (D#6 C44-3). The shell sandbox makes empty mount points for the paths
 * it protects (`sandboxStubs.ts`), and the agent CLI lists only some of them in the workspace's `.git/info/exclude`; the rest
 * (`.gitconfig`, `.idea`, `.vscode`, shell start-up names) stayed untracked, so an executor's `git add -A` committed them.
 *
 * At checkout the runner appends one marked block of root-anchored patterns to that file, once. A name the checked-out commit tracks is
 * never in the block, so a repo's own `.vscode/settings.json` or `.npmrc` still shows its edits. The write is no-follow: a template or a
 * hostile checkout could ship `.git/info` or `exclude` as a link, and a link would let the append land in another file. Those are
 * refused with the closed `workspace_git_refused`; no path is put in an error.
 */
import { closeSync, constants as fsConstants, fstatSync, lstatSync, mkdirSync, openSync, readSync, writeSync } from "node:fs";
import path from "node:path";
import { GitPathError } from "./git.js";
import { SANDBOX_PROTECTED_FILES } from "./sandboxStubs.js";

export const EXCLUDE_BEGIN = "# fx-runner sandbox stubs (begin)";
export const EXCLUDE_END = "# fx-runner sandbox stubs (end)";

/** The `.env` family the sandbox makes empty files for (the CLI's own block names the same eight). */
const ENV_STUBS: readonly string[] = [".env", ".env.local", ".env.development", ".env.development.local", ".env.test", ".env.test.local", ".env.production", ".env.production.local"];

/** Root-level names that are files, and those that are directories (the pattern gets a trailing slash). */
export const EXCLUDE_FILE_NAMES: readonly string[] = Object.freeze([...SANDBOX_PROTECTED_FILES, "package.json", ...ENV_STUBS, ".gitconfig"]);
export const EXCLUDE_DIR_NAMES: readonly string[] = Object.freeze([".idea", ".vscode", ".claude"]);

/** The most an existing `exclude` file may hold; a larger one is not something git or the CLI wrote. */
const MAX_EXCLUDE_BYTES = 256 * 1024;

const refuse = (): never => {
  throw new GitPathError("workspace_git_refused");
};

/** True when the commit tracks `name` itself or anything below it. */
function isTracked(name: string, trackedPaths: readonly string[]): boolean {
  return trackedPaths.some((entry) => entry === name || entry.startsWith(`${name}/`));
}

/** The block text for the candidate names the commit does not track, or `null` when nothing is left to exclude. */
export function excludeBlock(trackedPaths: readonly string[]): string | null {
  const lines = [
    ...EXCLUDE_FILE_NAMES.filter((name) => !isTracked(name, trackedPaths)).map((name) => `/${name}`),
    ...EXCLUDE_DIR_NAMES.filter((name) => !isTracked(name, trackedPaths)).map((name) => `/${name}/`),
  ];
  return lines.length === 0 ? null : `${EXCLUDE_BEGIN}\n${lines.join("\n")}\n${EXCLUDE_END}\n`;
}

function kindOf(target: string): "none" | "dir" | "other" {
  try {
    const stat = lstatSync(target);
    return stat.isDirectory() ? "dir" : "other"; // lstat: a link is "other"
  } catch (error) {
    // fx-swallow-ok: a missing entry is a normal answer; any other failure is replaced by the closed code (a system error carries a path)
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "none";
    return refuse();
  }
}

/**
 * Appends the block to `<workspace>/.git/info/exclude` unless a block is already there. `trackedPaths` is the checked-out commit's file list.
 * Refuses (`workspace_git_refused`) a `.git` or `.git/info` that is not a real directory, and an `exclude` that is a link, a FIFO, a
 * multi-link file or too large. Returns true when it wrote.
 */
export function writeWorkspaceExclude(workspace: string, trackedPaths: readonly string[]): boolean {
  if (!path.isAbsolute(workspace)) return refuse();
  const gitDir = path.join(workspace, ".git");
  if (kindOf(gitDir) !== "dir") return refuse();
  const info = path.join(gitDir, "info");
  const infoKind = kindOf(info);
  if (infoKind === "other") return refuse();
  const block = excludeBlock(trackedPaths);
  if (block === null) return false;
  let fd: number | null = null;
  try {
    if (infoKind === "none") mkdirSync(info, { mode: 0o755 });
    const file = path.join(info, "exclude");
    // One descriptor for the read and the append: the no-follow open refuses a link at the last component, and every later step works on
    // what was opened. Non-blocking, so a FIFO swapped in cannot hold the daemon.
    fd = openSync(file, fsConstants.O_RDWR | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK, 0o644);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_EXCLUDE_BYTES) return refuse();
    const buffer = Buffer.alloc(stat.size);
    let length = 0;
    while (length < stat.size) {
      const read = readSync(fd, buffer, length, stat.size - length, length);
      if (read === 0) break;
      length += read;
    }
    const existing = buffer.toString("utf8", 0, length);
    if (existing.split("\n").includes(EXCLUDE_BEGIN)) return false;
    writeSync(fd, `${existing === "" || existing.endsWith("\n") ? "" : "\n"}${block}`);
    return true;
  } catch (error) {
    // fx-swallow-ok: replaced by the closed code; a system error (ELOOP, EEXIST, ...) names a path
    if (error instanceof GitPathError) throw error;
    return refuse();
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
