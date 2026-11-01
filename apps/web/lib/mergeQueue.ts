import type { Pool } from "pg";
import { markWorkPending } from "@fx/core/src/pendingWork.js";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { createGitHubMergeGatePort, mergeQueue, type GitHubHttp } from "@fx/pipeline";
import type { AdvanceReviewDeps, RunnerPlaneMergeStore } from "@fx/worker";
import { DEQUEUE_PULL_REQUEST_DOCUMENT, ENABLE_AUTO_MERGE_DOCUMENT, ENQUEUE_PULL_REQUEST_DOCUMENT, MERGE_QUEUE_ENTRY_DOCUMENT, MERGE_QUEUE_READ_DOCUMENT, type GithubWebhookPayload, type GithubWebhookEventName } from "@fx/github";
import { createReviewDeps } from "./advanceReview";
import { bindCompleteDeltaReview, bindStartDeltaReview } from "./mergeQueueDeltaReview";
import { getWorker } from "./worker";
import { openInstallationHttp, readRepoAppLogin } from "./github/installationHttp";
import { openForRepo } from "./github/localOnlyHttp";

/**
 * D#519 MQ3-b: the merge queue's production wiring. The decisions are `mergeQueue.runQueueTick`'s; this file only binds its ports.
 *
 *  - `tickMergeQueueRepo`: GitHub through the merge gate's own client for the repository (the installation's `merge_gate` token), the
 *    gate through the review stage's `mergeGate` (the same reads and the one merge call, now given the signals that were green on the
 *    reviewed head), and the App's login for MQ3-a's identity check. A `runner_local` repository is not ticked: its merge belongs to the
 *    customer's runner (D#6), and the fenced client the cloud would use for it cannot read what the tick reads.
 *  - `sweepMergeQueue`: the cron's pass. It lists the repos that need a tick (a lapsed lease, or queued entries and no holder) and ticks
 *    each. A tick that parked its slot (CI still running) asks for the next pass in a little over the lease, so a missed webhook costs
 *    minutes, not the thirty-minute backstop.
 *  - `wakeMergeQueue`: the webhook's trigger. Pull request and check events change what the queue should do: a pull request closed
 *    outside the queue is settled, a finished check puts a `ci_not_green` entry back, and the sweep is told there is work. It reads
 *    only structured fields of the verified payload and only when the repository has a live entry.
 */

export const MERGE_QUEUE_RECHECK_MS = (mergeQueue.MERGE_QUEUE_LEASE_SECONDS + 30) * 1000;

export interface MergeQueueTickerDeps {
  /** The agent-run-writer pool: the gate reads reviewer rows through it, and the queue's own tables are reachable from it as `app_user`. */
  pool: Pool;
  orders: RunnerPlaneMergeStore;
  open?: typeof openInstallationHttp;
  review?: AdvanceReviewDeps;
  appLogin?: (repoId: string) => Promise<string>;
  /** MQ3-a's delta-review start. Absent: the real one, bound to the reviewer start (mergeQueueDeltaReview.ts). */
  startDeltaReview?: mergeQueue.StartDeltaReview;
  sleep?: (ms: number) => Promise<void>;
}

/** The merge gate's own GitHub client for the repository (the installation's `merge_gate` token). Null for a repository the cloud does not tick: no owner and name, or `runner_local`. */
export async function openQueueGitHub(pool: Pool, open: typeof openInstallationHttp, target: { accountId: string; repoId: string }): Promise<ReturnType<typeof createGitHubMergeGatePort> | null> {
  const repo = await withTenant(pool, target.accountId, async (c) =>
    (await c.query<{ gh_owner: string | null; gh_name: string | null; execution_mode: string }>(`SELECT gh_owner, gh_name, execution_mode FROM repos WHERE account_id = $1 AND id = $2`, [target.accountId, target.repoId])).rows[0],
  );
  if (!repo?.gh_owner || !repo.gh_name || repo.execution_mode === "runner_local") return null;
  const owner = repo.gh_owner;
  const name = repo.gh_name;
  const http = (await openForRepo(open, repo.execution_mode, "merge_gate", { repoId: target.repoId, owner, name })) as GitHubHttp;
  return createGitHubMergeGatePort({
    http,
    resolveRepo: async () => ({ owner, name }),
    markReadyForHumanMerge: async () => undefined,
    mergeMethod: "squash",
    // D#694 B6-3: without the pinned documents the port answers `direct` before any read, so the tick would update queue-mode branches and never see the rule's batch size.
    queueDocuments: { read: MERGE_QUEUE_READ_DOCUMENT, enqueue: ENQUEUE_PULL_REQUEST_DOCUMENT, autoMerge: ENABLE_AUTO_MERGE_DOCUMENT, dequeue: DEQUEUE_PULL_REQUEST_DOCUMENT, entry: MERGE_QUEUE_ENTRY_DOCUMENT },
  });
}

export async function tickMergeQueueRepo(deps: MergeQueueTickerDeps, target: { accountId: string; repoId: string }): Promise<mergeQueue.QueueTickResult | null> {
  const { pool, orders } = deps;
  const open = deps.open ?? openInstallationHttp;
  const review = deps.review ?? createReviewDeps(open);
  const inTenant: mergeQueue.QueueTickDeps["inTenant"] = (accountId, fn) => withTenant(pool, accountId, fn);
  const github = await openQueueGitHub(pool, open, target);
  if (!github) return null;
  const out = await mergeQueue.runQueueTick(
    {
      github,
      inTenant,
      ourLogin: await (deps.appLogin ?? readRepoAppLogin)(target.repoId),
      gate: async ({ entry, headSha, expectedSignals }) => {
        const res = await review.mergeGate(pool, { accountId: target.accountId, workItemId: entry.workItemId!, prNumber: entry.prNumber, expectedSignals, expectedHeadSha: headSha }, { orders });
        // A GitHub read that failed or a refused context is a throw: the step retries, the lease lapses, nothing is read as permission to merge.
        if (res.outcome === "refused" || res.outcome === "error") throw new Error(`merge queue: gate ${res.outcome}`);
        switch (res.outcome) {
          case "merged":
          case "merge_delegated":
          // D#694 B5: in the host's queue; the tick holds the entry settled and does not ask the gate again.
          case "merge_enqueued":
          case "pr_not_open":
          case "head_moved":
            return { outcome: res.outcome };
          case "ready_human_merges":
            return { outcome: res.outcome, reasons: res.reasons ?? [] };
          default:
            throw new Error("merge queue: gate answered an outcome this queue does not know");
        }
      },
      // D#694 B6-3: the rule's batch size bounds how many entries wait in the host's queue, and a queue branch is never updated by the product.
      queueInfo: (pr) => github.getMergeQueueInfo!(pr),
      startDeltaReview: deps.startDeltaReview ?? bindStartDeltaReview({ pool, worker: await getWorker(), open, github }),
      sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    },
    target,
  );
  // A default branch that is red or has no result yet is read again by the next sweep, so a missed webhook costs minutes (MQ-MAIN-RED-GUARD).
  const mainHeld = out.steps.some((s) => s.step === "released" && (s.why === "main_red" || s.why === "main_ci_unknown"));
  if (out.steps.some((s) => s.step === "parked") || out.waiting.length > 0 || mainHeld) await markWorkPending("merge-queue-sweep", { since: Date.now() + MERGE_QUEUE_RECHECK_MS });
  return out;
}

/**
 * The sweep's look at entries waiting on a delta review: when the workflow that drives the wait died, this is what moves them (a pass, or the
 * `completeDeltaReview` timeout), so an entry cannot stay in `awaiting_work` for good. Idempotent with the workflow's own wait step.
 */
export async function completeWaitingDeltaReviews(deps: MergeQueueTickerDeps, target: { accountId: string; repoId: string }): Promise<void> {
  const entries = await withTenant(deps.pool, target.accountId, (c) => mergeQueue.readQueue(c, target.accountId, target.repoId));
  const waiting = entries.filter((e) => e.state === "awaiting_work" && e.workKind === "delta_review");
  if (waiting.length === 0) return;
  const open = deps.open ?? openInstallationHttp;
  const github = await openQueueGitHub(deps.pool, open, target);
  if (!github) return;
  const complete = bindCompleteDeltaReview({ pool: deps.pool, worker: await getWorker(), open, github });
  for (const entry of waiting) await complete(entry);
}

export function sweepMergeQueue(deps: MergeQueueTickerDeps): Promise<mergeQueue.MergeQueueSweepResult> {
  return mergeQueue.sweepMergeQueue({
    listTargets: (now, limit) => mergeQueue.listMergeQueueSweepTargets(deps.pool, now, limit),
    inTenant: (accountId, fn) => withTenant(deps.pool, accountId, fn),
    // D#694 B6-4: the backstop for a lost merge or removal delivery; the client opens only when an entry is due for a read.
    reconcile: (target, maxReads) =>
      mergeQueue.reconcileHostQueued(
        {
          github: async () => {
            const github = await openQueueGitHub(deps.pool, deps.open ?? openInstallationHttp, target);
            return github ? { getQueueEntry: (pr) => github.getQueueEntry!(pr) } : null;
          },
          inTenant: (accountId, fn) => withTenant(deps.pool, accountId, fn),
        },
        { ...target, maxReads },
      ),
    tick: async (target) => {
      await completeWaitingDeltaReviews(deps, target);
      await tickMergeQueueRepo(deps, target);
    },
  });
}

export async function wakeMergeQueue(pool: Pool, event: { accountId: string; repoId: string; eventName: GithubWebhookEventName; payload: GithubWebhookPayload }): Promise<void> {
  const live = await withTenant(pool, event.accountId, (c) => mergeQueue.applyQueueEvent(c, event));
  if (live) await markWorkPending("merge-queue-sweep");
}
