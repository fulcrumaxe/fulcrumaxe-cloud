/**
 * What the job handler asks of git path B (D#6 R4a-3), in steps around the agent run:
 *  - `check`: before anything is made, refuse a job this path will not push;
 *  - `resume`: for a fix round with a kept session, say whether that workspace is still at the branch's tip;
 *  - `prepare`: fill the run's fresh workspace from the repo's mirror, on the run's own branch, or for a fix round on the existing one;
 *  - `publish`: after the agent has finished, push its commit to that branch.
 * The repo and the job's branch prefix come from the signed job; the branch name comes from the lease, and for a fix round from the
 * signed job's `continues.branch` once it has the shape of a run branch (C25 section 1.3). Nothing else reaches a ref name.
 */
import type { Job } from "@fulcrumaxe/runner-protocol";
import path from "node:path";
import { assertGitVersion, createGit, GitPathError, type GitDeps } from "./git.js";
import { createMirrors, type Mirrors, type MirrorDeps } from "./mirror.js";
import type { NixFromDefault, NixSource } from "./nixShell.js";
import { sweepSnapshots } from "./snapshot.js";
import { publishBranch, PUSH_BRANCH_PREFIX, pushPlan, workspaceHead, type PushLease, type Published } from "./push.js";

export type GitJob = Pick<Job, "repo" | "continues" | "branch_prefix" | "role" | "review">;

/** The only roles whose commits are pushed (C25 section 3.2). Any other role's commit stays in its workspace, which is discarded. */
export const PUSHING_ROLES: ReadonlySet<string> = new Set(["executor", "docs-writer"]);

export interface GitPath {
  /** Throws `GitPathError` for a job whose run this path will not push. Touches nothing. */
  check(job: GitJob, lease: PushLease): void;
  /**
   * A fix round only. Syncs the mirror and answers with the branch tip when the kept session's `workspace` is exactly at it, or null when
   * the workspace is not (stale, moved on, or not a clone this path made): the caller then starts a fresh workspace.
   */
  resume(job: GitJob, lease: PushLease, workspace: string): Promise<{ base: string } | null>;
  /** `workspace` is a new, empty directory. Returns the commit the run starts from (a fix round: the branch's tip). */
  prepare(job: GitJob, lease: PushLease, workspace: string): Promise<{ base: string }>;
  /**
   * Pushes the workspace's commit to the run's branch (a fix round: `continues.branch`, non-forced), unless the run added none or the
   * job's role does not push. `stopped` is asked right before the push: after a stop reply nothing is pushed.
   */
  publish(job: GitJob, lease: PushLease, workspace: string, base: string, stopped?: () => boolean): Promise<Published>;
  /** The paths the job's sandbox may read besides its workspace: exactly the repo mirror's `objects` directory, which the workspace borrows from. */
  readGrants(job: GitJob): string[];
  /**
   * D#6 R7c: what the repo's Nix dev shell may be built from at `sha`. A commit in the history of the mirror's default branch (the mirror's HEAD
   * follows it) is used as it is. Any other commit is replaced by its merge-base with that HEAD (`fromDefault`); with no merge-base the answer is `not_default_branch`. Optional: a path without a mirror gives none.
   */
  nixSource?(job: GitJob, sha: string): Promise<NixSource>;
}

export interface GitPathDeps extends GitDeps, Pick<MirrorDeps, "mirrorsRoot" | "stateDir" | "keepClear" | "remoteUrl"> {}

export function createGitPath(deps: GitPathDeps): GitPath {
  const git = createGit(deps);
  const mirrors: Mirrors = createMirrors({ git, mirrorsRoot: deps.mirrorsRoot, stateDir: deps.stateDir, ...(deps.keepClear === undefined ? {} : { keepClear: deps.keepClear }), ...(deps.remoteUrl === undefined ? {} : { remoteUrl: deps.remoteUrl }) });
  // Where a push's snapshot of the workspace's git files is made: the runner's private state, which the agent's sandbox never reaches.
  const snapshotsRoot = path.join(deps.stateDir, "git-snapshots");
  sweepSnapshots(snapshotsRoot); // a daemon that stopped mid-push left its snapshot behind
  return {
    check(job, lease) {
      if (job.branch_prefix !== PUSH_BRANCH_PREFIX) throw new GitPathError("push_ref_refused");
      pushPlan(lease, job.continues);
    },
    async resume(job, lease, workspace) {
      if (job.continues === null) return null;
      await assertGitVersion(git);
      const { dir, tip } = await mirrors.continuationTip(job.repo, job.continues);
      try {
        return (await workspaceHead(git, dir, workspace, snapshotsRoot)) === tip ? { base: tip } : null;
      } catch (error) {
        // A kept workspace this path cannot read as a clone it made is not resumed. The mirror's own failures were thrown above.
        if (error instanceof GitPathError) return null;
        throw error;
      }
    },
    async prepare(job, lease, workspace) {
      // Setup: a git older than the May 2024 security releases is refused before any mirror or workspace is made.
      await assertGitVersion(git);
      return mirrors.prepareWorkspace(job.repo, lease, workspace, job.continues, job.review ?? null);
    },
    readGrants: (job) => [mirrors.objects(job.repo)],
    async nixSource(job, sha) {
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) return { kind: "not_default_branch" };
      const dir = mirrors.dir(job.repo);
      // A commit outside the default branch (a review, fix round or run branch) is built from its merge-base with the mirror's HEAD, which is on the default
      // branch. The commit's own flake is never evaluated; only its two flake paths are compared by name, so no file of it is read.
      let rev = sha;
      let fromDefault: NixFromDefault | undefined;
      const onDefault = await git.run("mirror_failed", ["-C", dir, "merge-base", "--is-ancestor", sha, "HEAD"]).then(() => true, () => false);
      if (!onDefault) {
        let base: string;
        let changed: string;
        try {
          base = (await git.run("mirror_failed", ["-C", dir, "merge-base", sha, "HEAD"])).trim();
          if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(base)) return { kind: "not_default_branch" };
          changed = await git.run("mirror_failed", ["-C", dir, "diff-tree", "-r", "--name-only", "--no-renames", base, sha, "--", "flake.nix", "flake.lock"]);
        } catch {
          // fx-swallow-ok: git answers "no common ancestor" with an exit code; unrelated history (or a comparison that cannot be made) keeps the closed skip
          return { kind: "not_default_branch" };
        }
        rev = base;
        fromDefault = { rev: base, flakeChanged: changed.trim() !== "" };
      }
      try {
        await git.run("mirror_failed", ["-C", dir, "cat-file", "-e", `${rev}:flake.nix`]);
      } catch {
        // fx-swallow-ok: no flake.nix at this commit is the closed answer "no flake"
        return { kind: "no_flake" };
      }
      // A repo with submodules never gets a dev shell: a flake that sets `inputs.self.submodules` would make nix fetch the urls in `.gitmodules`, which can be
      // `file://` or local paths. Refusing the file itself is simpler and safer than reading the flake to see whether it asks for them.
      const hasSubmodules = await git.run("mirror_failed", ["-C", dir, "cat-file", "-e", `${rev}:.gitmodules`]).then(() => true, () => false);
      if (hasSubmodules) return { kind: "submodules" };
      try {
        return { kind: "flake", mirrorDir: dir, lock: await git.run("mirror_failed", ["-C", dir, "show", `${rev}:flake.lock`]), ...(fromDefault === undefined ? {} : { fromDefault }) };
      } catch {
        // fx-swallow-ok: no flake.lock at this commit is the closed answer "lock missing"
        return { kind: "flake", mirrorDir: dir, lock: null, ...(fromDefault === undefined ? {} : { fromDefault }) };
      }
    },
    publish: async (job, lease, workspace, base, stopped) =>
      !PUSHING_ROLES.has(job.role) ? { pushed: false } : publishBranch(git, mirrors.dir(job.repo), mirrors.url(job.repo), workspace, base, lease, snapshotsRoot, { continues: job.continues, ...(stopped === undefined ? {} : { stopped }) }),
  };
}
