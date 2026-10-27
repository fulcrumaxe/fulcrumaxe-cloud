/**
 * What the daemon recorded about a workspace's git folder at job setup, right after its own clone (D#6 RUNNER-HOSTREAD-GITDIR-SHAPE, fix round 1).
 *
 * The agent can, inside one sandboxed Bash call, move `.git` away and make a new one with the same refs and objects and a `config` of its own: the file
 * binds sit on files inside `.git`, not on `.git` itself, so the new `config` is writable until the call ends. A shape check alone passes such a folder.
 * So the daemon pins the identity of the folder and of its `config` (device and inode of both, and a digest of the config's bytes) and every host read compares:
 * a folder that was replaced, or a config that was rewritten, no longer matches. The pin also holds the one `objects/info/alternates` line the clone made.
 *
 * In memory only: a daemon that restarts has no pin, and an unpinned workspace is refused (it is never read on trust).
 */
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { GitPathError } from "./git.js";
import { readSmallRegular } from "./workspaceGit.js";

interface Pin {
  gitDev: number;
  gitIno: number;
  configDev: number;
  configIno: number;
  configSha: string;
  /** The `objects` directory of the mirror the workspace was cloned from: the only alternates line a read accepts. */
  mirrorObjects: string;
}

/** A config the clone writes is a few hundred bytes. */
const MAX_CONFIG_BYTES = 64 * 1024;

const pins = new Map<string, Pin>();

const refuse = (): never => {
  throw new GitPathError("workspace_git_refused");
};

function keyOf(workspace: string): string {
  try {
    return realpathSync(workspace);
  } catch {
    // fx-swallow-ok: a workspace that cannot be resolved has no pin; the caller refuses
    return path.resolve(workspace);
  }
}

function identityOf(workspace: string): Omit<Pin, "mirrorObjects"> {
  try {
    const git = lstatSync(path.join(workspace, ".git"));
    const config = lstatSync(path.join(workspace, ".git", "config"));
    if (!git.isDirectory() || !config.isFile()) return refuse();
    const sha = createHash("sha256").update(readSmallRegular(path.join(workspace, ".git", "config"), MAX_CONFIG_BYTES)).digest("hex");
    // The worktree-config file is the sandbox's empty stub or absent; anything else is config the agent wrote.
    try {
      if (lstatSync(path.join(workspace, ".git", "config.worktree")).size !== 0) return refuse();
    } catch (error) {
      // fx-swallow-ok: a missing worktree-config file is the normal case; any other failure is refused on the next line
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return refuse();
    }
    return { gitDev: git.dev, gitIno: git.ino, configDev: config.dev, configIno: config.ino, configSha: sha };
  } catch {
    // fx-swallow-ok: replaced by the closed code; the system error carries a path
    return refuse();
  }
}

/** Records the workspace's git folder as it is now. Call it only right after the daemon made or verified the clone. */
export function pinWorkspace(workspace: string, mirrorObjects: string): void {
  pins.set(keyOf(workspace), { ...identityOf(workspace), mirrorObjects });
}

export function unpinWorkspace(workspace: string): void {
  pins.delete(keyOf(workspace));
}

/** Returns the pinned mirror objects path, or throws `workspace_git_refused` when the workspace has no pin or its folder or config is not the one pinned. */
export function checkPin(workspace: string): string {
  const pin = pins.get(keyOf(workspace));
  if (pin === undefined) return refuse();
  const now = identityOf(workspace);
  if (now.gitDev !== pin.gitDev || now.gitIno !== pin.gitIno || now.configDev !== pin.configDev || now.configIno !== pin.configIno || now.configSha !== pin.configSha) return refuse();
  return pin.mirrorObjects;
}
