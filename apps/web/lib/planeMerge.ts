import type { Pool } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { enqueueDedupeKey, listHeadRemovals, recordDriverEvent } from "@fx/core/src/work-items/driverEvents.js";
import { DEQUEUE_PULL_REQUEST_DOCUMENT, ENABLE_AUTO_MERGE_DOCUMENT, ENQUEUE_PULL_REQUEST_DOCUMENT, MERGE_QUEUE_ENTRY_DOCUMENT, MERGE_QUEUE_READ_DOCUMENT } from "@fx/github";
import { createPgLocalReviewOptIn, createReviewGitHubPort, loadReviewContext, readItemRecordedPullRequest, readPublicPullRequest, runMergeGateForItem, type GitHubHttp, type MergeBlockReason } from "@fx/pipeline";
import type { PlaneMergeGoResult, PlaneMergeOrderFacts, PublicPullFacts, PublicQueueFacts } from "@fx/runner-cloud";
import { mergeGateAuthorTrust } from "./github/authorTrust";
import { openInstallationHttp } from "./github/installationHttp";
import { openForRepo } from "./github/localOnlyHttp";
import { createPrStateReader } from "./github/prState";

/**
 * D#6 PUBLIC-MERGE PR2b: the cloud's half of a paired `runner_local` item's merge order, built on the same pieces as the review stage (`advanceReview.ts`): the
 * merge gate, the fenced GitHub clients and the item's own records. The cloud never calls merge on the code repository here: its client for that repository has
 * no merge call at all (`withoutMerge`), and it reads paths and states only.
 *
 *   goPhase           the WHOLE gate again from fresh reads, with the runner's attestation for the content. The gate calls `delegate` at its merge call site, only
 *                     when nothing blocks. Nothing here decides to merge.
 *   readPublicPull    the public pull request's state through the fenced client (the cloud's own read, never the runner's report).
 *   readPublicQueue   the same with its merge-queue entry (D#694 B7-1), for a runner's `enqueued` report. recordEnqueued writes the item's `merge_enqueued` fact.
 *   recordMerged      a verified merge: the gate's `merged_by_gate` fact, the item's pull-request stage reconciled, and the private copy closed (best effort).
 */
export interface PlaneMergeOpsDeps {
  open?: typeof openInstallationHttp;
  /** Runs a callback with the pool the gate and the records run on (the worker's runner login, lent for the call). */
  withPool: <T>(fn: (pool: Pool) => Promise<T>) => Promise<T>;
  /** Moves the item as the webhook would after a merge; best effort. Absent: the webhook and the sweep do it. */
  reconcile?: (input: { accountId: string; workItemId: string; github: ReturnType<typeof createPrStateReader> }) => Promise<unknown>;
  /** Closes the private draft copy (a PATCH `state: closed`, the fence's A5) through the run-pull-request port. Absent: the copy is left to the cleanup sweep. */
  closePrivate?: (repo: { id: string; owner: string; name: string }, number: number) => Promise<void>;
}

interface GoInput {
  accountId: string;
  order: PlaneMergeOrderFacts;
  attestation: { reviewedHead: string; publicHead: string; same: boolean; incomplete: boolean; paths: readonly string[] };
  /** The runner listed `plane_merge_queue_v1` (D#694 B7-1); absent is false. */
  queueCapable?: boolean;
  delegate: () => Promise<{ delegated: true } | { delegated: false; reason: string }>;
}

/** The documents the port reads the queue with (the hosted client's pinned strings; the fence for a `runner_local` repo holds the read ones equal). The enqueue is never sent for a paired item. */
const QUEUE_DOCUMENTS = { read: MERGE_QUEUE_READ_DOCUMENT, enqueue: ENQUEUE_PULL_REQUEST_DOCUMENT, autoMerge: ENABLE_AUTO_MERGE_DOCUMENT, dequeue: DEQUEUE_PULL_REQUEST_DOCUMENT, entry: MERGE_QUEUE_ENTRY_DOCUMENT };

export function createPlaneMergeOps(deps: PlaneMergeOpsDeps) {
  const open = deps.open ?? openInstallationHttp;
  const openReviewHttp = (c: { repoId: string; owner: string; name: string; executionMode: string }) => openForRepo(open, c.executionMode, "merge_gate", { repoId: c.repoId, owner: c.owner, name: c.name }) as Promise<GitHubHttp>;
  // The code repository: the same fenced client without the merge call.
  const openPublicHttp = (c: { repoId: string; owner: string; name: string; executionMode: string }) => openForRepo(open, c.executionMode, "merge_gate", { repoId: c.repoId, owner: c.owner, name: c.name }, { withoutMerge: true }) as Promise<GitHubHttp>;

  const splitRepo = (codeRepo: string): { owner: string; name: string } => {
    const [owner, name, extra] = codeRepo.split("/");
    if (!owner || !name || extra !== undefined) throw new Error("plane merge: the order's code repository is malformed");
    return { owner, name };
  };

  async function go(pool: Pool, input: GoInput): Promise<PlaneMergeGoResult> {
    const { accountId, order } = input;
    const loaded = await loadReviewContext(pool, accountId, order.workItemId);
    if (!loaded.ok) return { kind: "refused", reason: loaded.reason };
    const c = loaded.ctx;
    // The order is for the item's CURRENT public pull request. Any other (a replaced push record, another repository) is a head that moved on.
    const lookup = await readPublicPullRequest(pool)(accountId, order.workItemId);
    const pub = lookup?.pr ?? null;
    const code = splitRepo(order.codeRepo);
    if (pub === null || pub.number !== order.prNumber || pub.owner.toLowerCase() !== code.owner.toLowerCase() || pub.name.toLowerCase() !== code.name.toLowerCase()) return { kind: "head_moved" };
    // The item's own (private) pull request: the run's recorded one.
    const recorded = await readItemRecordedPullRequest(pool, accountId, order.workItemId);
    if (recorded === null) return { kind: "refused", reason: "no_pull_request" };
    const http = await openReviewHttp({ repoId: c.repoId, owner: c.owner, name: c.name, executionMode: c.executionMode });
    let mergeMode: "queue" | "direct" = "direct";
    const out = await runMergeGateForItem(
      {
        pool,
        http,
        queueDocuments: QUEUE_DOCUMENTS,
        localReviewOptIn: createPgLocalReviewOptIn(pool),
        authorTrust: mergeGateAuthorTrust,
        publicPlane: { open: openPublicHttp, read: readPublicPullRequest(pool) },
        mergeDelegate: async (_args, { mergeMode: read }) => {
          // D#694 B7-1: the gate read the CODE repository's mode (not the private repo's). A queue repository's order goes only to a runner that can enqueue, and no credential is minted otherwise.
          if (read === "queue" && input.queueCapable !== true) return { delegated: false, reason: "runner_update_required" };
          const r = await input.delegate();
          if (r.delegated) mergeMode = read;
          return r.delegated ? { delegated: true } : { delegated: false, reason: r.reason as MergeBlockReason };
        },
      },
      { accountId, workItemId: order.workItemId, prNumber: recorded.number, goPhase: { attestation: input.attestation } },
    );
    switch (out.outcome) {
      case "merge_delegated":
        return { kind: "go", mergeMode };
      case "ready_human_merges":
        return { kind: "blocked", reasons: out.reasons };
      case "head_moved":
        return { kind: "head_moved" };
      case "pr_not_open":
        return { kind: "pr_not_open" };
      case "refused":
        return { kind: "refused", reason: out.reason };
      case "merged":
        // The cloud never merges here; a merged outcome would mean a delegate was bypassed.
        return { kind: "refused", reason: "unexpected_merged" };
    }
  }

  async function readPull(pool: Pool, input: { accountId: string; order: PlaneMergeOrderFacts }): Promise<PublicPullFacts> {
    const { accountId, order } = input;
    const loaded = await loadReviewContext(pool, accountId, order.workItemId);
    if (!loaded.ok) throw new Error("plane merge: the item cannot be read");
    const c = loaded.ctx;
    const code = splitRepo(order.codeRepo);
    // The branch is our own record's (a generated column of the push row), never the runner's.
    const branch = await withTenant(pool, accountId, async (client) => {
      const { rows } = await client.query<{ branch: string }>("SELECT branch FROM plane_pushes WHERE account_id = $1 AND id = $2", [accountId, order.planePushId]);
      return rows[0]?.branch ?? null;
    });
    if (branch === null) throw new Error("plane merge: the push record is gone");
    const http = await openPublicHttp({ repoId: c.repoId, owner: code.owner, name: code.name, executionMode: c.executionMode });
    const port = createReviewGitHubPort({ pool, http }, { ...c, owner: code.owner, name: code.name }, { accountId, workItemId: order.workItemId, prNumber: order.prNumber, recordedBranch: branch });
    const state = await port.getPullRequest({ repoId: c.repoId, prNumber: order.prNumber });
    return { open: state.state === "open" && !state.merged, merged: state.merged, headSha: state.headSha };
  }

  /** The public pull request and its queue entry, through the fenced client's queue reads (A13); the cloud never sends the enqueue. */
  async function readQueue(pool: Pool, input: { accountId: string; order: PlaneMergeOrderFacts }): Promise<PublicQueueFacts> {
    const { accountId, order } = input;
    const loaded = await loadReviewContext(pool, accountId, order.workItemId);
    if (!loaded.ok) throw new Error("plane merge: the item cannot be read");
    const c = loaded.ctx;
    const code = splitRepo(order.codeRepo);
    const http = await openPublicHttp({ repoId: c.repoId, owner: code.owner, name: code.name, executionMode: c.executionMode });
    const port = createReviewGitHubPort({ pool, http, queueDocuments: QUEUE_DOCUMENTS, pairedQueueReads: true }, { ...c, owner: code.owner, name: code.name }, { accountId, workItemId: order.workItemId, prNumber: order.prNumber });
    const read = await port.getQueueEntry!({ repoId: c.repoId, prNumber: order.prNumber });
    return { open: read.state === "open" && !read.merged, merged: read.merged, headSha: read.headSha, entryId: read.entry?.id ?? null };
  }

  /** The item's `merge_enqueued` fact after a verified enqueue: the public number and head, the key B6-2's webhook writes for the same entry (a head that was removed and queued again gets the next one). */
  async function recordEnqueued(pool: Pool, input: { accountId: string; order: PlaneMergeOrderFacts; entryId: string }): Promise<void> {
    const { accountId, order } = input;
    await withTenant(pool, accountId, async (client) => {
      const removals = (await listHeadRemovals(client, accountId, order.workItemId, order.expectedPublicHead, order.prNumber, { all: true })).length;
      await recordDriverEvent(client, accountId, { workItemId: order.workItemId, kind: "merge_enqueued", dedupeKey: enqueueDedupeKey(order.expectedPublicHead, removals), code: "queue", headSha: order.expectedPublicHead, prNumber: order.prNumber, queueEntryId: input.entryId });
    });
  }

  async function record(pool: Pool, input: { accountId: string; order: PlaneMergeOrderFacts }): Promise<{ privateCopy: "closed" | "left" | "failed" }> {
    const { accountId, order } = input;
    const loaded = await loadReviewContext(pool, accountId, order.workItemId);
    if (!loaded.ok) return { privateCopy: "left" };
    const c = loaded.ctx;
    const recorded = await readItemRecordedPullRequest(pool, accountId, order.workItemId);
    // The gate's own fact for a merge: the head the reviewers cleared and the item's own pull request number (as the gate records it).
    await withTenant(pool, accountId, (client) => recordDriverEvent(client, accountId, { workItemId: order.workItemId, kind: "merged_by_gate", dedupeKey: `merged:${order.expectedPublicHead}`, headSha: order.reviewedHead, ...(recorded !== null ? { prNumber: recorded.number } : {}) }));
    // The item's stage follows the public pull request (the webhook usually did it already); best effort, the sweep backs it up.
    if (deps.reconcile) {
      await deps.reconcile({ accountId, workItemId: order.workItemId, github: createPrStateReader(open) }).catch((error: unknown) => {
        // fx-swallow-ok: the stage is also moved by the webhook and the 10-minute sweep; a fixed line is logged
        console.warn(JSON.stringify({ event: "plane_merge.reconcile_failed", work_item_id: order.workItemId, name: error instanceof Error ? error.name.slice(0, 60) : null }));
      });
    }
    // The private draft copy: only the run's recorded pull request, only while open, only at the head the reviewers cleared.
    if (!deps.closePrivate || recorded === null) return { privateCopy: "left" };
    try {
      const http = await openReviewHttp({ repoId: c.repoId, owner: c.owner, name: c.name, executionMode: c.executionMode });
      const port = createReviewGitHubPort({ pool, http }, c, { accountId, workItemId: order.workItemId, prNumber: recorded.number });
      const priv = await port.getPullRequest({ repoId: c.repoId, prNumber: recorded.number });
      if (priv.state !== "open" || priv.merged || priv.headSha !== order.reviewedHead) return { privateCopy: "left" };
      await deps.closePrivate({ id: c.repoId, owner: c.owner, name: c.name }, recorded.number);
      return { privateCopy: "closed" };
    } catch (error) {
      // fx-swallow-ok: the merge is recorded; the branch cleanup closes the copy later. A fixed line is logged, never the error text.
      console.warn(JSON.stringify({ event: "plane_merge.private_copy_close_failed", work_item_id: order.workItemId, name: error instanceof Error ? error.name.slice(0, 60) : null }));
      return { privateCopy: "failed" };
    }
  }

  return {
    openReviewHttp,
    openPublicHttp,
    goPhase: (input: GoInput): Promise<PlaneMergeGoResult> => deps.withPool((pool) => go(pool, input)),
    readPublicPull: (input: { accountId: string; order: PlaneMergeOrderFacts }): Promise<PublicPullFacts> => deps.withPool((pool) => readPull(pool, input)),
    readPublicQueue: (input: { accountId: string; order: PlaneMergeOrderFacts }): Promise<PublicQueueFacts> => deps.withPool((pool) => readQueue(pool, input)),
    recordEnqueued: (input: { accountId: string; order: PlaneMergeOrderFacts; entryId: string }): Promise<void> => deps.withPool((pool) => recordEnqueued(pool, input)),
    recordMerged: (input: { accountId: string; order: PlaneMergeOrderFacts }) => deps.withPool((pool) => record(pool, input)),
  };
}
