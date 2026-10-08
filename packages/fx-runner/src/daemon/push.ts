/**
 * Git path B, the push (D#6 R4a-3): the daemon pushes a finished run's commit to GitHub itself, outside the agent's sandbox,
 * with the user's own git credential helper. The remote is GitHub itself; nothing here knows of any other host (the cloud-verified path is a different change).
 *
 * A fresh run pushes `fx/<run>-g<generation>`, a name built from the lease alone (`pushPlan`): the run id the cloud handed out and
 * the claim's generation. A fix round (C25 section 1) pushes to the branch of the pull request it fixes, `continues.branch` of the
 * verified signed job, which must have the exact shape of a name some run's lease produced (`CONTINUES_BRANCH`) and must already
 * exist on the remote with its tip at the commit the run started from. Nothing the agent wrote and no other text in the job reaches
 * a ref name. The push is never forced, and `runPush` refuses any refspec other than the one the plan gives.
 *
 * The push runs from the mirror, not from the workspace: the workspace's config is the agent's. The commit is first fetched
 * from a daemon-owned snapshot of the workspace's refs and objects into a private ref of the mirror (git reading a repository,
 * under the guard config), then pushed from there, so the credential helper only ever sees a URL this runner chose.
 */
import path from "node:path";
import { assertGitVersion, GitPathError, type Git } from "./git.js";
import { takeSnapshot } from "./snapshot.js";
import { assertGitDirShape, assertWorkspaceGit } from "./workspaceGit.js";

/** The one place a pushed branch can live. A job whose own prefix is anything else is not pushed. */
export const PUSH_BRANCH_PREFIX = "fx/";

const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What identifies a claimed run: the run id and the generation of the claim that holds it. */
export interface PushLease {
  runId: string;
  leaseGeneration: number;
}

/** The only branch a fix round may push: the shape of a name `pushPlan` makes for a fresh run (the uuid is the fresh run's, not necessarily the parent's). */
export const CONTINUES_BRANCH = /^fx\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-g[1-9][0-9]{0,8}$/;

/** What `pushPlan` reads of a job's `continues`: the branch of the pull request being fixed. */
export interface PushContinues {
  branch: string;
}

export interface PushPlan {
  /** `fx/<run>-g<generation>`, or `continues.branch` for a fix round. */
  branch: string;
  /** Where the workspace's commit is held in the mirror until it is pushed. */
  localRef: string;
  /** `<localRef>:refs/heads/<branch>`: no `+`, no wildcard. */
  refspec: string;
}

/** The branch of a fix round, or `push_ref_refused` when it is not the shape of a run branch. */
export function continuesBranch(continues: PushContinues): string {
  if (typeof continues.branch !== "string" || !CONTINUES_BRANCH.test(continues.branch)) throw new GitPathError("push_ref_refused");
  return continues.branch;
}

/**
 * The plan for a lease, and for a fix round the verified job's `continues`. Throws `push_ref_refused` for an id or generation that
 * is not what the cloud hands out, and for a `continues.branch` that is not the shape of a run branch. The private ref stays named
 * by this lease, so two jobs never share one; only the target differs.
 */
export function pushPlan(lease: PushLease, continues: PushContinues | null = null): PushPlan {
  if (typeof lease.runId !== "string" || !RUN_ID.test(lease.runId) || !Number.isSafeInteger(lease.leaseGeneration) || lease.leaseGeneration < 1) throw new GitPathError("push_ref_refused");
  const name = `${lease.runId}-g${lease.leaseGeneration}`;
  const branch = continues === null ? `${PUSH_BRANCH_PREFIX}${name}` : continuesBranch(continues);
  const localRef = `refs/fx-push/${name}`;
  return { branch, localRef, refspec: `${localRef}:refs/heads/${branch}` };
}

/** Throws unless `refspec` is exactly the one this lease's plan gives. */
export function assertAllowedRefspec(refspec: string, lease: PushLease, continues: PushContinues | null = null): void {
  if (refspec !== pushPlan(lease, continues).refspec) throw new GitPathError("push_ref_refused");
}

/** Pushes `refspec`, out of the mirror at `mirrorDir`, to `url`, after checking it against the lease. Never forced, no hooks, no tags, no submodules. */
export async function runPush(git: Git, mirrorDir: string, url: string, refspec: string, lease: PushLease, continues: PushContinues | null = null): Promise<void> {
  assertAllowedRefspec(refspec, lease, continues);
  await git.run("push_failed", ["-C", mirrorDir, "push", "--porcelain", "--atomic", "--no-verify", "--no-follow-tags", "--no-recurse-submodules", "--", url, refspec]);
}

/** The tip of `refs/heads/<branch>` on the remote, or null when there is no such branch. Matches the exact ref name only (a pattern also matches deeper names). */
export async function remoteBranchTip(git: Git, mirrorDir: string, url: string, branch: string): Promise<string | null> {
  const listing = await git.run("push_failed", ["-C", mirrorDir, "ls-remote", "--heads", "--", url, `refs/heads/${branch}`]);
  for (const line of listing.split("\n")) {
    const [sha, ref] = line.split("\t");
    if (ref === `refs/heads/${branch}` && sha !== undefined && OBJECT_ID.test(sha)) return sha;
  }
  return null;
}

/**
 * The commit a resumed session's workspace is at. Read the way the push reads it: from a snapshot the daemon made, never from
 * the workspace's own `.git`. Throws `snapshot_refused` or `push_ref_refused` for a workspace that is not what a clone makes.
 */
export async function workspaceHead(git: Git, mirrorDir: string, workspace: string, snapshotsRoot: string): Promise<string> {
  const mirrorObjects = path.join(mirrorDir, "objects");
  assertWorkspaceGit(path.resolve(workspace), mirrorObjects);
  const snapshot = await takeSnapshot({ workspace: path.resolve(workspace), mirrorObjects, root: snapshotsRoot });
  try {
    assertGitDirShape(snapshot.gitDir, mirrorObjects, true);
    return (await git.run("push_failed", ["--git-dir", snapshot.gitDir, "rev-parse", "--verify", "HEAD^{commit}"])).trim();
  } finally {
    snapshot.remove();
  }
}

export interface PublishOptions {
  /** The verified job's `continues`: the push then goes to its branch, which must exist with its tip at `base`. */
  continues?: PushContinues | null;
  /** True once the cloud has said stop: nothing is pushed after that (C24 section 1.3). Asked right before the push. */
  stopped?: () => boolean;
}

export type Published = { pushed: false } | { pushed: true; branch: string; sha: string };

/**
 * Brings the workspace's HEAD into the mirror and pushes it to the run's branch. Nothing is pushed when HEAD is still the commit the
 * workspace started from (`base`): the cloud then finds no commit and ends the run `no_commit`, and no empty branch is left behind.
 *
 * The fetch never reads the workspace's `.git`. That directory is the agent's, and a process that outlived the run can still
 * write it. The daemon copies the few things a fetch needs into a snapshot of its own (`takeSnapshot`), checks the snapshot, and
 * fetches from that with a strict `upload-pack` (the path exactly as given, no `.git` suffix tried). The snapshot is deleted
 * whatever happens. `snapshotsRoot` is a directory under the runner's private state.
 */
export async function publishBranch(git: Git, mirrorDir: string, url: string, workspace: string, base: string, lease: PushLease, snapshotsRoot: string, options: PublishOptions = {}): Promise<Published> {
  const continues = options.continues ?? null;
  const plan = pushPlan(lease, continues);
  if (!OBJECT_ID.test(base)) throw new GitPathError("push_ref_refused");
  await assertGitVersion(git);
  const mirrorObjects = path.join(mirrorDir, "objects");
  // Early fail-fast on the workspace as it stands. It is not what the fetch trusts: the snapshot is.
  assertWorkspaceGit(path.resolve(workspace), mirrorObjects);
  const snapshot = await takeSnapshot({ workspace: path.resolve(workspace), mirrorObjects, root: snapshotsRoot });
  try {
    await git.run("push_failed", ["-C", mirrorDir, "update-ref", "-d", plan.localRef]);
    // The snapshot is checked last, right before the fetch reads it: it is what the fetch trusts, so it is what is validated.
    assertGitDirShape(snapshot.gitDir, mirrorObjects, true);
    try {
      await git.run("push_failed", ["-C", mirrorDir, "fetch", "--upload-pack=git upload-pack --strict", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", "--", snapshot.gitDir, `HEAD:${plan.localRef}`]);
      const sha = (await git.run("push_failed", ["-C", mirrorDir, "rev-parse", "--verify", `${plan.localRef}^{commit}`])).trim();
      if (sha === base) return { pushed: false };
      // Backstop for the checks above: what is pushed must grow from the commit this run started at, whatever git read to find it.
      await git.run("push_ref_refused", ["-C", mirrorDir, "merge-base", "--is-ancestor", base, sha]);
      if (continues !== null) {
        // A fix round updates a pull request's branch, so the branch must still be there, still at the commit this run started from.
        // A moved tip cannot take this push (it would not be a fast-forward), and the daemon does not retry: it reports `push_rejected`.
        const remoteTip = await remoteBranchTip(git, mirrorDir, url, plan.branch);
        if (remoteTip === null) throw new GitPathError("continuation_branch_missing");
        if (remoteTip !== base) throw new GitPathError("push_rejected");
      }
      if (options.stopped?.() === true) return { pushed: false };
      try {
        await runPush(git, mirrorDir, url, plan.refspec, lease, continues);
      } catch (error) {
        if (continues === null || !(error instanceof GitPathError) || error.code !== "push_failed") throw error;
        // The branch can move between the check and the push, and the remote then refuses it as non-fast-forward. Say so from what the remote holds now; the push itself is not retried. (A branch deleted in that window is re-created by the push: the accepted gap of C25 section 1.4.)
        const now = await remoteBranchTip(git, mirrorDir, url, plan.branch).catch(() => undefined); // fx-swallow-ok: the push's own closed code stands when the remote cannot be asked
        if (now !== undefined && now !== base) throw new GitPathError("push_rejected");
        throw error;
      }
      return { pushed: true, branch: plan.branch, sha };
    } finally {
      // fx-swallow-ok: a private ref left behind is deleted at the start of the next publish for this lease
      await git.run("push_failed", ["-C", mirrorDir, "update-ref", "-d", plan.localRef]).catch(() => undefined);
    }
  } finally {
    snapshot.remove();
  }
}
