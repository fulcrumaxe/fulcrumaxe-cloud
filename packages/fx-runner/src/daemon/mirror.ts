/**
 * Git path B, the mirror (D#6 R4a-3): one persistent bare repository per repo, kept in the runner's own cache directory (not the
 * state directory: the sandbox must be able to read one mirror's objects, and may never read the state directory), and a per-job
 * workspace made from it with `git clone --reference`, so a job fetches nothing the mirror already holds.
 *
 * The mirror is ours: its config and its (switched-off) hooks are never written by the agent, and every push goes out of it. A
 * workspace is the agent's. The mirror is named by the repo's id from the signed job, which is one plain path segment, never by
 * the owner or name text. The mirror borrows from nothing (no alternates of its own) and never runs a gc by itself: a kept
 * workspace borrows the mirror's objects, and an automatic gc after a pruning fetch could delete one it still needs.
 */
import { chmodSync, lstatSync, mkdirSync, rmSync, type Stats } from "node:fs";
import path from "node:path";
import { segmentUnder } from "../job/plainSegment.js";
import { CREDENTIAL_FLOOR, pathsOverlap } from "../sandbox/sandboxSettings.js";
import { GitPathError, type Git } from "./git.js";
import { continuesBranch, pushPlan, type PushContinues, type PushLease } from "./push.js";

/** The parts of a job's `repo` the git path reads. */
export interface RepoRef {
  id: string;
  owner: string;
  name: string;
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const BRANCH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/** The address of a repo on GitHub over https. The owner and name are checked again here; they are never used any other way. */
export function githubUrl(repo: RepoRef): string {
  if (!OWNER.test(repo.owner) || !NAME.test(repo.name) || /^\.+$/.test(repo.name)) throw new GitPathError("mirror_failed");
  return `https://github.com/${repo.owner}/${repo.name}.git`;
}

/**
 * Where the mirrors live: `${XDG_CACHE_HOME:-~/.cache}/fx-runner/mirrors` on Linux (an `XDG_CACHE_HOME` that is not absolute is
 * ignored, as the XDG rule says), `~/Library/Caches/fx-runner/mirrors` on macOS. `FX_RUNNER_HOME` does not move it.
 */
export function mirrorsRootFor(input: { home: string; platform: NodeJS.Platform; xdgCacheHome?: string | undefined }): string {
  if (!path.isAbsolute(input.home)) throw new TypeError("mirror home directory must be absolute");
  if (input.platform === "darwin") return path.join(input.home, "Library", "Caches", "fx-runner", "mirrors");
  const cache = input.xdgCacheHome !== undefined && path.isAbsolute(input.xdgCacheHome) ? input.xdgCacheHome : path.join(input.home, ".cache");
  return path.join(cache, "fx-runner", "mirrors");
}

/** The runner roots and protected locations the mirrors directory must not overlap, as the sandbox builder lists them. */
export function mirrorKeepClear(input: { home: string; stateDir: string; binaryDir: string; workspaceRoot: string; tempRoot: string }): string[] {
  return [input.stateDir, input.binaryDir, input.workspaceRoot, input.tempRoot, ...CREDENTIAL_FLOOR.map((entry) => path.join(input.home, entry))];
}

export interface MirrorDeps {
  git: Git;
  /** The directory the mirrors live in (absolute): see `mirrorsRootFor`. Created 0700. */
  mirrorsRoot: string;
  /** The runner's private state directory (absolute). The mirrors directory may not overlap it. */
  stateDir: string;
  /** Further runner roots and protected locations (`mirrorKeepClear`) the mirrors directory may not overlap, as written or through links. */
  keepClear?: readonly string[];
  /** The address of a repo's remote. Default: GitHub over https. Replaceable so a test can point at a local repository. */
  remoteUrl?: (repo: RepoRef) => string;
}

export interface Mirrors {
  /** The remote address for a repo. */
  url(repo: RepoRef): string;
  /** The directory of the repo's bare mirror (not created). */
  dir(repo: RepoRef): string;
  /** The `objects` directory of the repo's mirror: the one thing a job's sandbox may read of it. */
  objects(repo: RepoRef): string;
  /** Creates the mirror on first use, brings it up to date with the remote otherwise, and returns the default branch's tip. */
  sync(repo: RepoRef): Promise<{ dir: string; base: string }>;
  /**
   * Makes `workspace` (an empty directory) a clone of the mirror and returns the commit it starts at. A fresh run is on a new branch
   * for this lease; a fix round is on the existing `continues.branch` at its tip, and nothing is made if the mirror has no such branch.
   */
  prepareWorkspace(repo: RepoRef, lease: PushLease, workspace: string, continues?: PushContinues | null): Promise<{ base: string }>;
  /** Brings the mirror up to date and returns the tip of `continues.branch`, or throws `continuation_branch_missing`. */
  continuationTip(repo: RepoRef, continues: PushContinues): Promise<{ dir: string; tip: string }>;
}

export function createMirrors(deps: MirrorDeps): Mirrors {
  if (!path.isAbsolute(deps.stateDir) || !path.isAbsolute(deps.mirrorsRoot)) throw new TypeError("mirror directories must be absolute");
  const root = path.resolve(deps.mirrorsRoot);
  const url = (repo: RepoRef): string => (deps.remoteUrl ?? githubUrl)(repo);
  const dir = (repo: RepoRef): string => {
    try {
      return segmentUnder(root, `${repo.id}.git`);
    } catch {
      // fx-swallow-ok: replaced by the closed code; the bad id is not echoed
      throw new GitPathError("mirror_failed");
    }
  };

  const lstatOrNull = (target: string): Stats | null => {
    try {
      return lstatSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      // fx-swallow-ok: replaced by the closed code; the system error carries a path
      throw new GitPathError("mirror_dir_insecure");
    }
  };

  /** The mirrors directory, created 0700 or checked to be: not a link (a dangling one included), a directory, closed to group and others, overlapping no runner root. */
  function ensureRoot(): void {
    const clear = [deps.stateDir, ...(deps.keepClear ?? [])];
    const apart = (): void => {
      if (clear.some((other) => pathsOverlap(root, other))) throw new GitPathError("mirror_dir_insecure");
    };
    apart();
    try {
      mkdirSync(path.dirname(root), { recursive: true, mode: 0o700 });
      if (lstatOrNull(root) === null) mkdirSync(root, { mode: 0o700 });
    } catch (error) {
      if (error instanceof GitPathError) throw error;
      // fx-swallow-ok: replaced by the closed code; the system error carries a path
      throw new GitPathError("mirror_dir_insecure");
    }
    const stat = lstatOrNull(root);
    if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()) throw new GitPathError("mirror_dir_insecure");
    apart();
    if ((stat.mode & 0o077) !== 0) {
      chmodSync(root, 0o700);
      if ((lstatSync(root).mode & 0o077) !== 0) throw new GitPathError("mirror_dir_insecure");
    }
  }

  /** Refuses a mirror that borrows objects from anywhere, and switches its automatic gc and maintenance off. */
  async function secure(mirror: string): Promise<void> {
    if (lstatOrNull(path.join(mirror, "objects", "info", "alternates")) !== null) throw new GitPathError("mirror_failed");
    await deps.git.run("mirror_failed", ["-C", mirror, "config", "gc.auto", "0"]);
    await deps.git.run("mirror_failed", ["-C", mirror, "config", "maintenance.auto", "false"]);
  }

  /** Points the mirror's HEAD at the remote's default branch, when the remote names one we know. */
  async function followDefaultBranch(mirror: string): Promise<void> {
    const listing = await deps.git.run("mirror_failed", ["-C", mirror, "ls-remote", "--symref", "origin", "HEAD"]);
    const named = listing.match(/^ref: refs\/heads\/(\S+)\tHEAD$/m)?.[1];
    if (named === undefined || !BRANCH.test(named)) return;
    await deps.git.run("mirror_failed", ["-C", mirror, "symbolic-ref", "HEAD", `refs/heads/${named}`]);
  }

  async function sync(repo: RepoRef): Promise<{ dir: string; base: string }> {
    ensureRoot();
    const mirror = dir(repo);
    const remote = url(repo);
    if (lstatOrNull(mirror) === null) {
      try {
        await deps.git.run("mirror_failed", ["clone", "--bare", "--no-tags", "--", remote, mirror]);
        await deps.git.run("mirror_failed", ["-C", mirror, "config", "remote.origin.fetch", "+refs/heads/*:refs/heads/*"]);
        await secure(mirror);
      } catch (error) {
        rmSync(mirror, { recursive: true, force: true }); // a half-made mirror is never reused
        throw error;
      }
    } else {
      await secure(mirror);
      await deps.git.run("mirror_failed", ["-C", mirror, "config", "remote.origin.url", remote]);
      await deps.git.run("mirror_failed", ["-C", mirror, "fetch", "--prune", "--no-tags", "--no-write-fetch-head", "origin"]);
      await followDefaultBranch(mirror);
    }
    const base = (await deps.git.run("mirror_failed", ["-C", mirror, "rev-parse", "--verify", "HEAD^{commit}"])).trim();
    return { dir: mirror, base };
  }

  async function continuationTip(repo: RepoRef, continues: PushContinues): Promise<{ dir: string; tip: string }> {
    const branch = continuesBranch(continues);
    const { dir: mirror } = await sync(repo);
    const tip = (await deps.git.run("continuation_branch_missing", ["-C", mirror, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`])).trim();
    return { dir: mirror, tip };
  }

  return {
    url,
    dir,
    objects: (repo) => path.join(dir(repo), "objects"),
    sync,
    continuationTip,
    async prepareWorkspace(repo, lease, workspace, continues = null) {
      const plan = pushPlan(lease, continues);
      if (continues !== null) {
        const { dir: mirror, tip } = await continuationTip(repo, continues);
        await deps.git.run("workspace_failed", ["clone", "--reference", mirror, "--no-local", "--", mirror, workspace]);
        await deps.git.run("workspace_failed", ["-C", workspace, "checkout", "-B", plan.branch, tip]);
        return { base: tip };
      }
      const { dir: mirror, base } = await sync(repo);
      await deps.git.run("workspace_failed", ["clone", "--reference", mirror, "--no-local", "--", mirror, workspace]);
      await deps.git.run("workspace_failed", ["-C", workspace, "checkout", "-b", plan.branch]);
      return { base };
    },
  };
}
