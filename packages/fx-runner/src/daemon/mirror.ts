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
import { WaitAborted, withKeyLock } from "./keyedLock.js";
import { CREDENTIAL_FLOOR, pathsOverlap } from "../sandbox/sandboxSettings.js";
import { GitPathError, type Git } from "./git.js";
import { writeWorkspaceExclude } from "./workspaceExclude.js";
import { continuesBranch, pushPlan, type PushContinues, type PushLease } from "./push.js";

/** A root listing at least this long (the capture keeps 64 K) is treated as possibly cut. */
const LISTING_CAP_GUARD = 60 * 1024;

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

/**
 * The three runner directories under the cache directory that a job's sandbox can read or is made under: the mirrors, the workspaces
 * and the job temp directories. One function, used by `run`, the sandbox probe and the protection-bypass location check, so they agree.
 */
export function cacheRootsFor(input: { home: string; platform: NodeJS.Platform; xdgCacheHome?: string | undefined }): { mirrorsRoot: string; workspaceRoot: string; tempRoot: string } {
  const mirrorsRoot = mirrorsRootFor(input);
  const cacheDir = path.dirname(mirrorsRoot);
  return { mirrorsRoot, workspaceRoot: path.join(cacheDir, "workspaces"), tempRoot: path.join(cacheDir, "tmp") };
}

/** The runner roots and protected locations the mirrors directory must not overlap, as the sandbox builder lists them. */
export function mirrorKeepClear(input: { home: string; stateDir: string; binaryDir: string; workspaceRoot: string; tempRoot: string }): string[] {
  return [input.stateDir, input.binaryDir, input.workspaceRoot, input.tempRoot, ...CREDENTIAL_FLOOR.map((entry) => path.join(input.home, entry))];
}

/** The part of a review job the workspace is made from: the one commit to review. */
export interface ReviewTarget {
  head_sha: string;
}

/** A commit id as the job schema accepts it (SHA-1 or SHA-256, lowercase). Checked again here before the value reaches a git argument. */
const REVIEW_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

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
  /** The daemon's stop signal: a job waiting for another job's turn on a mirror stops waiting when it aborts (D#6 C43-4). */
  signal?: AbortSignal;
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
   * A review job (`review`, D#6 R4d-4) is on a detached HEAD at exactly `review.head_sha`, with no local branch, and nothing is made
   * unless the mirror holds that commit on at least one of its branches (`review_sha_not_in_mirror`).
   *
   * Jobs on one repo take turns on its mirror (D#6 C43-3): `sync`, `continuationTip` and `prepareWorkspace` hold the repo's lock, so two
   * fetches never run in one bare repository at once and a workspace is never cloned while a pruning fetch is rewriting refs. Jobs on
   * different repos overlap.
   */
  prepareWorkspace(repo: RepoRef, lease: PushLease, workspace: string, continues?: PushContinues | null, review?: ReviewTarget | null): Promise<{ base: string }>;
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

  async function syncUnlocked(repo: RepoRef): Promise<{ dir: string; base: string }> {
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

  async function continuationTipUnlocked(repo: RepoRef, continues: PushContinues): Promise<{ dir: string; tip: string }> {
    const branch = continuesBranch(continues);
    const { dir: mirror } = await syncUnlocked(repo);
    const tip = (await deps.git.run("continuation_branch_missing", ["-C", mirror, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`])).trim();
    return { dir: mirror, tip };
  }

  /**
   * One queue per mirror directory, shared by every `createMirrors` in the process (path A makes one per job): the key is the mirror's own
   * path. A lock covers a whole operation, and only the `Unlocked` functions are called from inside one, so a lock is never taken twice.
   */
  const locked = <T>(repo: RepoRef, fn: () => Promise<T>): Promise<T> =>
    withKeyLock(dir(repo), fn, deps.signal).catch((error: unknown) => {
      // fx-swallow-ok: an abort while waiting becomes the closed git-path code; any other failure is the operation's own and passes through
      throw error instanceof WaitAborted ? new GitPathError("mirror_failed") : error;
    });

  /** After a checkout: keeps the sandbox's stub files out of `git add -A`, except for names the checked-out commit tracks (D#6 C44-3). */
  async function excludeStubs(workspace: string): Promise<void> {
    // `ls-tree` without `-r` names only the root entries (a tracked directory by its own name), so the answer stays small. The names are
    // not passed as arguments: the test guard refuses a git argv that names the agent's own directory.
    const listing = await deps.git.run("workspace_failed", ["-C", workspace, "ls-tree", "-z", "--name-only", "HEAD"]);
    // The capture keeps 64 K; a root listing that long may be cut, and a cut list could hide a tracked name, so it is not used.
    if (listing.length >= LISTING_CAP_GUARD) throw new GitPathError("workspace_failed");
    writeWorkspaceExclude(workspace, listing.split("\0").filter((entry) => entry !== ""));
  }

  async function prepareUnlocked(repo: RepoRef, lease: PushLease, workspace: string, continues: PushContinues | null, review: ReviewTarget | null): Promise<{ base: string }> {
    if (review !== null) {
      // D#6 R4d-4 (C33 section 1.3): review exactly this commit and no other. The sync has just fetched, so there is no second fetch and no wait.
      if (!REVIEW_SHA.test(review.head_sha)) throw new GitPathError("review_sha_not_in_mirror");
      const { dir: mirror } = await syncUnlocked(repo);
      const sha = review.head_sha;
      await deps.git.run("review_sha_not_in_mirror", ["-C", mirror, "cat-file", "-e", `${sha}^{commit}`]);
      // A commit that is in the mirror's objects but on no branch (a superseded head after a force-push, or a fork's pull ref) is not reviewed.
      const holders = await deps.git.run("review_sha_not_in_mirror", ["-C", mirror, "for-each-ref", "--contains", sha, "--format=%(refname)", "refs/heads/"]);
      if (holders.trim() === "") throw new GitPathError("review_sha_not_in_mirror");
      await deps.git.run("workspace_failed", ["clone", "--reference", mirror, "--no-local", "--", mirror, workspace]);
      await deps.git.run("workspace_failed", ["-C", workspace, "checkout", "--detach", sha]);
      await excludeStubs(workspace);
      return { base: sha };
    }
    const plan = pushPlan(lease, continues);
    if (continues !== null) {
      const { dir: mirror, tip } = await continuationTipUnlocked(repo, continues);
      await deps.git.run("workspace_failed", ["clone", "--reference", mirror, "--no-local", "--", mirror, workspace]);
      await deps.git.run("workspace_failed", ["-C", workspace, "checkout", "-B", plan.branch, tip]);
      await excludeStubs(workspace);
      return { base: tip };
    }
    const { dir: mirror, base } = await syncUnlocked(repo);
    await deps.git.run("workspace_failed", ["clone", "--reference", mirror, "--no-local", "--", mirror, workspace]);
    await deps.git.run("workspace_failed", ["-C", workspace, "checkout", "-b", plan.branch]);
    await excludeStubs(workspace);
    return { base };
  }

  return {
    url,
    dir,
    objects: (repo) => path.join(dir(repo), "objects"),
    sync: (repo) => locked(repo, () => syncUnlocked(repo)),
    continuationTip: (repo, continues) => locked(repo, () => continuationTipUnlocked(repo, continues)),
    prepareWorkspace: (repo, lease, workspace, continues = null, review = null) => locked(repo, () => prepareUnlocked(repo, lease, workspace, continues, review)),
  };
}
