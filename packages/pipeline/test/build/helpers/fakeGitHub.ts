import type {
  CiSnapshot,
  MergeBlockReason,
  MergeCallOutcome,
  MergeGateGitHubPort,
  PullRequestState,
} from "../../../src/build/mergeGate.js";
import type { PullRequestRef } from "../../../src/build/types.js";

/**
 * A fixture GitHub for the merge-gate table. `getPullRequest` returns the
 * PR PLUS the hostile, human-writable fields a real PR carries (`body`,
 * `labels`, `comments`) so the table proves the gate ignores them rather
 * than merely never being handed them. CI is keyed by commit SHA, the way
 * GitHub's checks API is.
 */
export interface FakePullRequest extends PullRequestState {
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
}

export class FakeGitHub implements MergeGateGitHubPort {
  pr: FakePullRequest;
  readonly mergeCalls: { sha: string }[] = [];
  readonly humanMarks: { headSha: string; reasons: readonly MergeBlockReason[] }[] = [];
  readonly ciQueries: string[] = [];
  private readonly opts: FakeGitHubOptions;

  constructor(opts: FakeGitHubOptions) {
    this.opts = opts;
    this.pr = opts.pr;
  }

  async getPullRequest(_pr: PullRequestRef): Promise<PullRequestState> {
    // A copy carrying the hostile fields: the gate must not read them.
    return { ...this.pr, labels: [...this.pr.labels], comments: [...this.pr.comments] } as PullRequestState;
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
