import type {
  BranchComparison,
  CiSnapshot,
  DequeueOutcome,
  EnqueueOutcome,
  MergeBlockReason,
  MergeCallOutcome,
  MergeGateGitHubPort,
  MergeQueueMode,
  PullRequestMergeability,
  PullRequestState,
  QueueEntryReading,
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
  /**
   * D#694 B5: give the fake a merge queue. Absent: the fake has no queue methods at all (a port from before the queue, which the gate reads as `direct`).
   * `"throw"` models a read that fails. The fake still merges directly when asked and the head matches, so a test that expects NO direct call proves the gate chose
   * the queue over a bypass the app could have used.
   */
  queueMode?: MergeQueueMode["mode"] | "throw";
  /** What the enqueue call answers (default: accepted, entry `MQE_kwDOtest1`, position 1). May move the head (a push racing the call). */
  enqueue?: EnqueueOutcome | ((fake: FakeGitHub, args: { expectedHeadOid: string }) => EnqueueOutcome);
  /** D#694 B6-1: what the dequeue call answers (default: the entry `MQE_kwDOtest1` removed). Present with `queueMode`; absent otherwise. */
  dequeue?: DequeueOutcome;
  /** D#694 B6-1: what the queue-entry read answers (default: open, queued at position 1 on the PR's own head). A function reads the fake's CURRENT head. */
  queueEntry?: QueueEntryReading | ((fake: FakeGitHub) => QueueEntryReading);
}

export class FakeGitHub implements MergeGateGitHubPort {
  pr: FakePullRequest;
  readonly mergeCalls: { sha: string }[] = [];
  readonly humanMarks: { headSha: string; reasons: readonly MergeBlockReason[] }[] = [];
  readonly ciQueries: string[] = [];
  readonly updateCalls: { expectedHeadSha: string }[] = [];
  readonly queueModeCalls: string[] = [];
  readonly enqueueCalls: { expectedHeadOid: string }[] = [];
  readonly dequeueCalls: number[] = [];
  readonly entryReads: number[] = [];
  getMergeQueueMode?: (pr: PullRequestRef, baseRef: string) => Promise<MergeQueueMode>;
  enqueuePullRequest?: (pr: PullRequestRef, args: { expectedHeadOid: string }) => Promise<EnqueueOutcome>;
  dequeuePullRequest?: (pr: PullRequestRef) => Promise<DequeueOutcome>;
  getQueueEntry?: (pr: PullRequestRef) => Promise<QueueEntryReading>;
  mergeability: Pick<PullRequestMergeability, "mergeable" | "mergeableState">;
  private readonly opts: FakeGitHubOptions;

  constructor(opts: FakeGitHubOptions) {
    this.opts = opts;
    this.pr = opts.pr;
    this.mergeability = opts.mergeability ?? { mergeable: true, mergeableState: "clean" };
    const mode = opts.queueMode;
    if (mode !== undefined) {
      this.getMergeQueueMode = async (_pr, baseRef) => {
        this.queueModeCalls.push(baseRef);
        if (mode === "throw") throw new Error("queue read failed");
        return { mode, source: "fake" };
      };
      this.enqueuePullRequest = async (_pr, args) => {
        this.enqueueCalls.push({ expectedHeadOid: args.expectedHeadOid });
        const e = opts.enqueue ?? { enqueued: true as const, via: "queue" as const, entryId: "MQE_kwDOtest1", position: 1 };
        return typeof e === "function" ? e(this, args) : e;
      };
      this.dequeuePullRequest = async (pr) => {
        this.dequeueCalls.push(pr.prNumber);
        return opts.dequeue ?? { dequeued: true, entryId: "MQE_kwDOtest1" };
      };
      this.getQueueEntry = async (pr) => {
        this.entryReads.push(pr.prNumber);
        const e = opts.queueEntry;
        if (typeof e === "function") return e(this);
        return e ?? { state: this.pr.state, merged: this.pr.merged, headSha: this.pr.headSha, entry: { id: "MQE_kwDOtest1", state: "queued", position: 1 } };
      };
    }
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
