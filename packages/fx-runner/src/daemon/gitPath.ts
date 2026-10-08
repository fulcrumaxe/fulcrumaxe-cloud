/**
 * What the job handler asks of git path B (D#6 R4a-3), in three steps around the agent run:
 *  - `check`: before anything is made, refuse a job this path will not push;
 *  - `prepare`: fill the run's fresh workspace from the repo's mirror, on the run's own branch;
 *  - `publish`: after the agent has finished, push its commit to that branch.
 * The repo and the job's branch prefix come from the signed job; the branch name comes from the lease and nothing else.
 */
import type { Job } from "@fulcrumaxe/runner-protocol";
import path from "node:path";
import { assertGitVersion, createGit, GitPathError, type GitDeps } from "./git.js";
import { createMirrors, type Mirrors, type MirrorDeps } from "./mirror.js";
import { sweepSnapshots } from "./snapshot.js";
import { publishBranch, PUSH_BRANCH_PREFIX, pushPlan, type PushLease, type Published } from "./push.js";

export type GitJob = Pick<Job, "repo" | "continues" | "branch_prefix" | "role">;

/** The only roles whose commits are pushed (C25 section 3.2). Any other role's commit stays in its workspace, which is discarded. */
export const PUSHING_ROLES: ReadonlySet<string> = new Set(["executor", "docs-writer"]);

export interface GitPath {
  /** Throws `GitPathError` for a job whose run this path will not push. Touches nothing. */
  check(job: GitJob, lease: PushLease): void;
  /** `workspace` is a new, empty directory. Returns the commit the run starts from. */
  prepare(job: GitJob, lease: PushLease, workspace: string): Promise<{ base: string }>;
  /** Pushes the workspace's commit to the run's branch, unless the run added none or the job's role does not push. */
  publish(job: GitJob, lease: PushLease, workspace: string, base: string): Promise<Published>;
  /** The paths the job's sandbox may read besides its workspace: exactly the repo mirror's `objects` directory, which the workspace borrows from. */
  readGrants(job: GitJob): string[];
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
      // A fix round continues an existing branch; this path pushes only a run's own `fx/<run>-g<generation>`. Refused before the agent runs.
      if (job.continues !== null) throw new GitPathError("continuation_unsupported");
      if (job.branch_prefix !== PUSH_BRANCH_PREFIX) throw new GitPathError("push_ref_refused");
      pushPlan(lease);
    },
    async prepare(job, lease, workspace) {
      // Setup: a git older than the May 2024 security releases is refused before any mirror or workspace is made.
      await assertGitVersion(git);
      return mirrors.prepareWorkspace(job.repo, lease, workspace);
    },
    readGrants: (job) => [mirrors.objects(job.repo)],
    publish: async (job, lease, workspace, base) => (!PUSHING_ROLES.has(job.role) ? { pushed: false } : publishBranch(git, mirrors.dir(job.repo), mirrors.url(job.repo), workspace, base, lease, snapshotsRoot)),
  };
}
