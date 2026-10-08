/**
 * Git path B, the push (D#6 R4a-3): the daemon pushes a finished run's commit to GitHub itself, outside the agent's sandbox,
 * with the user's own git credential helper. The remote is GitHub itself; nothing here knows of any other host (the cloud-verified path is a different change).
 *
 * The only ref ever pushed is `fx/<run>-g<generation>`, and its name is built from the lease alone (`pushPlan`): the run id the
 * cloud handed out and the claim's generation. Nothing the agent wrote and nothing in the job's text reaches a ref name. The push
 * is never forced, and `runPush` refuses any refspec other than the one the lease gives.
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

export interface PushPlan {
  /** `fx/<run>-g<generation>` */
  branch: string;
  /** Where the workspace's commit is held in the mirror until it is pushed. */
  localRef: string;
  /** `<localRef>:refs/heads/<branch>`: no `+`, no wildcard. */
  refspec: string;
}

/** The plan for a lease. Throws `push_ref_refused` for an id or generation that is not what the cloud hands out. */
export function pushPlan(lease: PushLease): PushPlan {
  if (typeof lease.runId !== "string" || !RUN_ID.test(lease.runId) || !Number.isSafeInteger(lease.leaseGeneration) || lease.leaseGeneration < 1) throw new GitPathError("push_ref_refused");
  const name = `${lease.runId}-g${lease.leaseGeneration}`;
  const branch = `${PUSH_BRANCH_PREFIX}${name}`;
  const localRef = `refs/fx-push/${name}`;
  return { branch, localRef, refspec: `${localRef}:refs/heads/${branch}` };
}

/** Throws unless `refspec` is exactly the one this lease's plan gives. */
export function assertAllowedRefspec(refspec: string, lease: PushLease): void {
  if (refspec !== pushPlan(lease).refspec) throw new GitPathError("push_ref_refused");
}

/** Pushes `refspec`, out of the mirror at `mirrorDir`, to `url`, after checking it against the lease. Never forced, no hooks, no tags, no submodules. */
export async function runPush(git: Git, mirrorDir: string, url: string, refspec: string, lease: PushLease): Promise<void> {
  assertAllowedRefspec(refspec, lease);
  await git.run("push_failed", ["-C", mirrorDir, "push", "--porcelain", "--atomic", "--no-verify", "--no-follow-tags", "--no-recurse-submodules", "--", url, refspec]);
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
export async function publishBranch(git: Git, mirrorDir: string, url: string, workspace: string, base: string, lease: PushLease, snapshotsRoot: string): Promise<Published> {
  const plan = pushPlan(lease);
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
      await runPush(git, mirrorDir, url, plan.refspec, lease);
      return { pushed: true, branch: plan.branch, sha };
    } finally {
      // fx-swallow-ok: a private ref left behind is deleted at the start of the next publish for this lease
      await git.run("push_failed", ["-C", mirrorDir, "update-ref", "-d", plan.localRef]).catch(() => undefined);
    }
  } finally {
    snapshot.remove();
  }
}
