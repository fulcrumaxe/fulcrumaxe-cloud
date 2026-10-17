import type {
  BranchComparison,
  CiSnapshot,
  MergeBlockReason,
  MergeCallOutcome,
  MergeGateGitHubPort,
  PullRequestMergeability,
  PullRequestState,
  UpdateBranchOutcome,
} from "../../../src/build/mergeGate.js";
import type { PullRequestRef } from "../../../src/build/types.js";

/**
 * A fixture GitHub for the merge-gate table. `getPullRequest` returns the
 * PR PLUS the hostile, human-writable fields a real PR carries (`body`,
 * `labels`, `comments`) so the table proves the gate ignores them rather
 * than merely never being handed them. CI is keyed by commit SHA, the way
 * GitHub's checks API is.
 */
export interface FakePullRequest extends Omit<PullRequestState, "baseRef" | "defaultBranch"> {
  /** GitHub always sends both (the real contract: `base.ref` and `base.repo.default_branch`). A fixture that says neither is a PR into the default branch, "main". */
  baseRef?: string;
  defaultBranch?: string;
  body: string;
  labels: string[];
  comments: string[];
}

export interface FakeGitHubOptions {
  pr: FakePullRequest;
  ciBySha?: Record<string, CiSnapshot>;
  /** Called on every merge attempt; return the outcome the fake GitHub
   * gives. May mutate `pr.headSha` to simulate a push racing the merge. */
  onMerge?: (fake: FakeGitHub, args: { sha: string }) => MergeCallOutcome;
  /** A buggy port that answers the CI query with this snapshot whatever
   * SHA was asked for. */
  ciAlwaysReturns?: CiSnapshot;
  /** What the re-read PR says about mergeability (default: mergeable, clean). A test may change it between calls. */
  mergeability?: Pick<PullRequestMergeability, "mergeable" | "mergeableState">;
  /** The compare of the base against the head (default: identical). */
  comparison?: BranchComparison;
  /** Whether protection requires up-to-date branches (default false), or a function that throws to model an unreadable rule. */
  requiresUpToDate?: boolean | (() => boolean);
  updateBranchOutcome?: UpdateBranchOutcome;
}

export class FakeGitHub implements MergeGateGitHubPort {
  pr: FakePullRequest;
  readonly mergeCalls: { sha: string }[] = [];
  readonly humanMarks: { headSha: string; reasons: readonly MergeBlockReason[] }[] = [];
  readonly ciQueries: string[] = [];
  readonly updateCalls: { expectedHeadSha: string }[] = [];
  mergeability: Pick<PullRequestMergeability, "mergeable" | "mergeableState">;
  private readonly opts: FakeGitHubOptions;

  constructor(opts: FakeGitHubOptions) {
    this.opts = opts;
    this.pr = opts.pr;
    this.mergeability = opts.mergeability ?? { mergeable: true, mergeableState: "clean" };
  }

  async getMergeability(_pr: PullRequestRef): Promise<PullRequestMergeability> {
    return { headSha: this.pr.headSha, state: this.pr.state, merged: this.pr.merged, ...this.mergeability };
  }

  async updateBranch(_pr: PullRequestRef, args: { expectedHeadSha: string }): Promise<UpdateBranchOutcome> {
    this.updateCalls.push({ expectedHeadSha: args.expectedHeadSha });
    return this.opts.updateBranchOutcome ?? { outcome: "accepted" };
  }

  async compareToBase(_pr: PullRequestRef, _headSha: string): Promise<BranchComparison> {
    return this.opts.comparison ?? { status: "identical", aheadBy: 0, behindBy: 0, files: null, filesTruncated: false };
  }

  async requiresUpToDateBranch(_pr: PullRequestRef): Promise<boolean> {
    const v = this.opts.requiresUpToDate;
    return typeof v === "function" ? v() : v === true;
  }

  async getPullRequest(_pr: PullRequestRef): Promise<PullRequestState> {
    // A copy carrying the hostile fields: the gate must not read them.
    return { ...this.pr, baseRef: this.pr.baseRef ?? "main", defaultBranch: this.pr.defaultBranch ?? "main", labels: [...this.pr.labels], comments: [...this.pr.comments] } as PullRequestState;
  }

  async getCiSnapshot(_pr: PullRequestRef, headSha: string): Promise<CiSnapshot> {
    this.ciQueries.push(headSha);
    if (this.opts.ciAlwaysReturns) return this.opts.ciAlwaysReturns;
    return this.opts.ciBySha?.[headSha] ?? snap(headSha, [], []);
  }

  async mergePullRequest(_pr: PullRequestRef, args: { sha: string }): Promise<MergeCallOutcome> {
    this.mergeCalls.push({ sha: args.sha });
    if (this.opts.onMerge) return this.opts.onMerge(this, args);
    return this.pr.headSha === args.sha ? { merged: true } : { merged: false, httpStatus: 409 };
  }

  async markReadyForHumanMerge(_pr: PullRequestRef, args: { headSha: string; reasons: readonly MergeBlockReason[] }): Promise<void> {
    this.humanMarks.push({ headSha: args.headSha, reasons: [...args.reasons] });
  }
}

/** A COMPLETE snapshot: `total_count` equals the collected lists (H14c-CI-1). */
export function snap(
  headSha: string,
  checkRuns: CiSnapshot["checkRuns"],
  statuses: CiSnapshot["statuses"],
  requiredContexts: readonly string[] = [],
  requiredAppChecks: CiSnapshot["requiredAppChecks"] = [],
): CiSnapshot {
  return {
    headSha,
    checkRuns,
    checkRunsTotalCount: checkRuns.length,
    statuses,
    statusesTotalCount: statuses.length,
    requiredContexts,
    requiredAppChecks,
  };
}

export function greenCi(headSha: string, requiredContexts: readonly string[] = []): CiSnapshot {
  return snap(
    headSha,
    [
      { name: "check", status: "completed", conclusion: "success" },
      { name: "lint", status: "completed", conclusion: "neutral" },
    ],
    [{ context: "ci/unit", state: "success" }],
    requiredContexts,
  );
}
