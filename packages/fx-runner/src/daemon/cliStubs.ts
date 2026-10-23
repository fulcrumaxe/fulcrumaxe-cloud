/**
 * What the Claude Code CLI makes at start-up when subprocess scrubbing (`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`) is on (D#6 RUNNER-CWD-1), read off
 * the bundle of build 2.1.309: empty placeholder files and directories over the paths it protects, in the directory it was started in and in
 * the home directory, the version-control entries `.git/config.worktree` (empty) and `.git/commondir` (`.`), and one block appended to
 * `.git/info/exclude`. Closed lists: a new name in a later build is a deliberate change to this file.
 *
 * Three uses: the short questions run with scrubbing off, in an empty launch directory (`shortQuestionEnv`, `launchDir.ts`); `doctor` warns
 * about these names where they sit empty (`findCliStubs`, nothing is deleted); and a job's workspace is cleared of the ones made during the
 * run before its check and its publish (`daemon/workspaceStubs.ts`).
 */
import { closeSync, constants as fsConstants, lstatSync, openSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const CLI_ENV_STUBS: readonly string[] = Object.freeze([".env", ".env.local", ".env.development", ".env.development.local", ".env.test", ".env.test.local", ".env.production", ".env.production.local"]);
/** Files made empty in the directory the CLI starts in. */
export const CLI_CWD_STUB_FILES: readonly string[] = Object.freeze([".npmrc", ".yarnrc", ".yarnrc.yml", "bunfig.toml", "package.json", ".gitmodules", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", ...CLI_ENV_STUBS]);
/** Directories made (with their parents) in the directory the CLI starts in. */
export const CLI_CWD_STUB_DIRS: readonly string[] = Object.freeze([".claude/commands", ".claude/agents", "node_modules/.bin"]);
/** Directories made inside that directory's `.git` when one exists. */
export const CLI_GIT_STUB_DIRS: readonly string[] = Object.freeze(["info", "modules", "worktrees", "glab-cli"]);
/** The line the CLI's block in `.git/info/exclude` starts with. */
export const CLI_EXCLUDE_HEADER = "# claude-code scrub-mode stubs";
/** Files made empty in the home directory, and directories made there. */
export const CLI_HOME_STUB_FILES: readonly string[] = Object.freeze([".gitconfig", ".bash_profile", ".bashrc", ".bash_aliases", ".profile", ".zshrc", ".bunfig.toml", ".netrc", ".npmrc", ".yarnrc", ".yarnrc.yml"]);
export const CLI_HOME_STUB_DIRS: readonly string[] = Object.freeze([".config/gh", ".config/glab-cli", ".config/git", ".config/pip", ".pip"]);

/**
 * The environment of a short question (`--version`, `--help`, `auth status`): the run's own, with subprocess scrubbing off. A short question
 * starts no tool subprocess, so the scrubbing protects nothing there, and with it on the CLI writes its placeholders into the home directory.
 * Model runs keep it on (`FIXED_ENV`).
 */
export function shortQuestionEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  return { ...env, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "0" };
}

/** True for a regular, single-link, 0-byte file (never a link). */
function isEmptyFile(file: string): boolean {
  try {
    const info = lstatSync(file);
    return info.isFile() && info.size === 0 && info.nlink === 1;
  } catch {
    // fx-swallow-ok: a missing or unreadable entry is not a placeholder
    return false;
  }
}

/** True for a real, empty directory (never a link). */
function isEmptyDir(dir: string): boolean {
  try {
    return lstatSync(dir).isDirectory() && readdirSync(dir).length === 0;
  } catch {
    // fx-swallow-ok: a missing or unreadable entry is not a placeholder
    return false;
  }
}

/**
 * The CLI placeholders `dir` holds, by name: the empty files and empty directories of the given lists, and for a start directory the
 * `.git/commondir` holding only `.`, an empty `.git/config.worktree` and the CLI's block in `.git/info/exclude`. Reads only; follows no link.
 */
export function findCliStubs(dir: string, kind: "home" | "cwd"): string[] {
  const files = kind === "home" ? CLI_HOME_STUB_FILES : CLI_CWD_STUB_FILES;
  const dirs = kind === "home" ? CLI_HOME_STUB_DIRS : CLI_CWD_STUB_DIRS;
  const found = [...files.filter((name) => isEmptyFile(path.join(dir, name))), ...dirs.filter((name) => isEmptyDir(path.join(dir, name)))];
  if (kind === "cwd") {
    const git = path.join(dir, ".git");
    try {
      if (lstatSync(git).isDirectory()) {
        if (isEmptyFile(path.join(git, "config.worktree"))) found.push(".git/config.worktree");
        const commondir = lstatSync(path.join(git, "commondir"), { throwIfNoEntry: false });
        if (commondir?.isFile() === true && commondir.size <= 2) found.push(".git/commondir");
        const exclude = lstatSync(path.join(git, "info", "exclude"), { throwIfNoEntry: false });
        if (exclude?.isFile() === true && exclude.size <= 256 * 1024 && readText(path.join(git, "info", "exclude")).split("\n").includes(CLI_EXCLUDE_HEADER)) found.push(".git/info/exclude (a block headed \"claude-code scrub-mode stubs\")");
      }
    } catch {
      // fx-swallow-ok: a `.git` that cannot be read is simply not reported on
    }
  }
  return found;
}

function readText(file: string): string {
  try {
    return readFileSyncNoFollow(file);
  } catch {
    // fx-swallow-ok: unreadable is reported as nothing
    return "";
  }
}

/** A no-follow, non-blocking read of a small file. */
function readFileSyncNoFollow(file: string): string {
  const fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}
