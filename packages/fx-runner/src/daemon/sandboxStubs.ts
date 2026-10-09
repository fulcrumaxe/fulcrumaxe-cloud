/**
 * What the Claude Code shell sandbox leaves in a workspace (D#6 R4d-2, correction C32 section 0). The sandbox (bubblewrap) makes a
 * mount point for each path it protects, before the agent's first command: empty files at the workspace root, and a few empty
 * entries inside `.git`. They were read off the kept workspace of the first real runner build (CLI 2.1.295), whose `.git/info/exclude`
 * also carries a "claude-code scrub-mode stubs" block naming the root files.
 *
 * Two uses, both closed lists:
 *  - the workspace pre-check (`workspaceGit.ts`) accepts exactly these `.git` entries and nothing looser;
 *  - the publish step (`push.ts`) refuses to push a commit that adds one of the root files as a 0-byte blob.
 * If the CLI adds a stub, the pre-check refuses with the closed `workspace_git_refused` and a person updates this file.
 */

/** `.git/commondir`: a regular, single-link file of at most this many bytes, holding nothing or exactly `.`. */
export const STUB_COMMONDIR_MAX_BYTES = 2;
export const STUB_COMMONDIR_CONTENTS: ReadonlySet<string> = new Set(["", ".", ".\n"]);
/** `.git/config.worktree`: a regular, single-link, empty file. */
export const STUB_EMPTY_FILE = "config.worktree";
/** `.git/modules`, `.git/worktrees`, `.git/glab-cli`: real, empty directories. */
export const STUB_EMPTY_DIRS: readonly string[] = Object.freeze(["modules", "worktrees", "glab-cli"]);

/** The empty files the sandbox makes for its protected paths: the workspace root's, as listed in the workspace's own `.git/info/exclude`, and the shell start-up files. */
export const SANDBOX_PROTECTED_FILES: readonly string[] = Object.freeze([
  "bunfig.toml",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".gitmodules",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  ".bash_profile",
  ".bashrc",
  ".profile",
  ".zshrc",
  ".zprofile",
  ".bash_login",
  ".zshenv",
]);

/** `.env` and `.env.*` (the CLI makes `.env`, `.env.local` and the development, test and production pairs). */
const ENV_FILE = /^\.env(?:\..+)?$/;

/** True when `repoPath` (a path inside the repository) names a file the sandbox makes an empty stub for, at any depth. */
export function isSandboxStubName(repoPath: string): boolean {
  const name = repoPath.slice(repoPath.lastIndexOf("/") + 1);
  return SANDBOX_PROTECTED_FILES.includes(name) || ENV_FILE.test(name);
}

/** `:(glob)` pathspecs that select the names `isSandboxStubName` accepts, so a listing of added paths stays small whatever the commits hold. */
export const SANDBOX_STUB_PATHSPECS: readonly string[] = Object.freeze([...SANDBOX_PROTECTED_FILES.map((name) => `:(glob)**/${name}`), ":(glob)**/.env", ":(glob)**/.env.*"]);

/** The id of the empty blob, in a SHA-1 and in a SHA-256 repository. */
export const EMPTY_BLOB_IDS: ReadonlySet<string> = new Set(["e69de29bb2d1d6434b8b29ae775ad8c2e48c5391", "473a0f4c3be8a93681a267e3b1e9a7dcda1185436fe141f7749120a303721813"]);
