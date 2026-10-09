import { linkSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * What the Claude Code shell sandbox left in the kept workspace of the first real runner build (D#6 R4d-2, C32 section 0; CLI 2.1.295),
 * pinned here so a change in the list is a deliberate change to this file.
 *
 * Inside `.git`, all stamped within a millisecond of each other, 0.2 s after the clone: `commondir` (1 byte, `.`), an empty
 * `config.worktree`, and empty `modules`, `worktrees` and `glab-cli` directories.
 */
export const OBSERVED_GIT_STUBS = { commondir: ".", configWorktree: "", emptyDirs: ["modules", "worktrees", "glab-cli"] } as const;

/** The 0-byte files at the workspace root (also named in the workspace's `.git/info/exclude`, under "claude-code scrub-mode stubs"). */
export const OBSERVED_ROOT_STUBS: readonly string[] = [
  "bunfig.toml",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".gitmodules",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  ".env",
  ".env.local",
  ".env.development",
  ".env.development.local",
  ".env.test",
  ".env.test.local",
  ".env.production",
  ".env.production.local",
];

/** Makes exactly the shapes above in `workspace`, the way the sandbox does. */
export function addSandboxStubs(workspace: string): void {
  const gitDir = path.join(workspace, ".git");
  writeFileSync(path.join(gitDir, "commondir"), OBSERVED_GIT_STUBS.commondir);
  writeFileSync(path.join(gitDir, "config.worktree"), OBSERVED_GIT_STUBS.configWorktree);
  for (const name of OBSERVED_GIT_STUBS.emptyDirs) mkdirSync(path.join(gitDir, name));
  for (const name of OBSERVED_ROOT_STUBS) writeFileSync(path.join(workspace, name), "");
}

/** A second hard link to `file`, so its link count is 2. */
export function addHardLink(file: string, to: string): void {
  linkSync(file, to);
}
