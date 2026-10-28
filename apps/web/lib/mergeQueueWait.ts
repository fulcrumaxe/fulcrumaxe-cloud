import type { Pool } from "pg";
import { markWorkPending } from "@fx/core/src/pendingWork.js";
import { readStackParentPull } from "@fx/core/src/work-items/stackParentPull.js";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { loadReviewContext, mergeQueue, readPublicPullRequest } from "@fx/pipeline";
import { bindCompleteDeltaReview } from "./mergeQueueDeltaReview";
import { openQueueGitHub } from "./mergeQueue";
import { openInstallationHttp } from "./github/installationHttp";
import type { ReviewWorker } from "./advanceReviewSteps";
import type { StepWho } from "./advanceStageSteps";

/**
 * D#519 MQ3-b-2b: the workflow's two steps against the merge queue (apps/web/workflows/workItemAdvance.ts holds the directives).
 *
 *  - `enqueueBody`: after every required reviewer passed, a HOSTED, UNPAIRED item goes into its repo's queue instead of calling the gate itself.
 *    A paired item (its merge belongs to the public plane's order), a `runner_local` one, a stacked child, a halted item, or a worker without a
 *    pool is `queued: false` and the workflow calls the direct gate exactly as before: nothing about those repos changes.
 *  - `waitBody`: one look at the entry. A delta review that is running is moved on here (`completeDeltaReview`), so the workflow's own durable wait
 *    is what drives it; the tick, started by the cron behind the `merge-queue-sweep` marker, takes the slot, refreshes, waits for CI and merges.
 */
export type QueueWorker = ReviewWorker & { withRunnerPool?<T>(fn: (pool: Pool) => Promise<T>): Promise<T> };

export type QueueWaitOut = { state: "waiting" | "merged" | "in_review" | "closed" | "cancelled" | "missing" | "halted" } | { state: "stopped"; reason: string };

/** `now`: the item is halted (a cancel; nothing else sets it). `stale`: it is halted now, or was and has been resumed since this workflow began. */
async function haltState(pool: Pool, who: StepWho): Promise<{ now: boolean; stale: boolean }> {
  const r = await withTenant(pool, who.accountId, async (c) => (await c.query<{ halted: boolean; halt_epoch: number }>("SELECT halted_at IS NOT NULL AS halted, halt_epoch FROM work_items WHERE id = $1 AND account_id = $2", [who.workItemId, who.accountId])).rows[0]);
  return { now: !r || r.halted, stale: !r || r.halted || r.halt_epoch !== who.haltEpoch };
}

export async function enqueueBody(worker: QueueWorker | null, who: StepWho, input: { prNumber: number; headSha: string }): Promise<{ queued: boolean }> {
  if (!worker?.withRunnerPool) return { queued: false };
  const queued = await worker.withRunnerPool(async (pool) => {
    if ((await haltState(pool, who)).stale) return null;
    const loaded = await loadReviewContext(pool, who.accountId, who.workItemId);
    if (!loaded.ok || loaded.ctx.executionMode === "runner_local") return null;
    if ((await readPublicPullRequest(pool)(who.accountId, who.workItemId)) !== null) return null;
    if ((await withTenant(pool, who.accountId, (c) => readStackParentPull(c, who.workItemId))) !== null) return null;
    // `approved_at` is stamped here the first time and never again: an existing entry keeps its own.
    const entry = await withTenant(pool, who.accountId, (c) =>
      mergeQueue.enqueueEntry(c, { accountId: who.accountId, repoId: loaded.ctx.repoId, workItemId: who.workItemId, prNumber: input.prNumber, headSha: input.headSha, approvedAt: new Date() }),
    );
    return entry.outcome === "final" ? null : entry.entry.id;
  });
  if (queued === null) return { queued: false };
  await markWorkPending("merge-queue-sweep");
  return { queued: true };
}

export async function waitBody(worker: QueueWorker | null, who: StepWho): Promise<QueueWaitOut> {
  if (!worker?.withRunnerPool) return { state: "missing" };
  return worker.withRunnerPool(async (pool) => {
    const halt = await haltState(pool, who);
    if (halt.stale) {
      // A cancel ends the entry (its runs were cancelled by the cancel itself); a resumed item's entry is left to the workflow that took over.
      if (halt.now) await withTenant(pool, who.accountId, (c) => mergeQueue.cancelWorkItemEntry(c, { accountId: who.accountId, workItemId: who.workItemId }));
      return { state: halt.now ? "cancelled" : "halted" };
    }
    const read = () => withTenant(pool, who.accountId, (c) => mergeQueue.getEntryByWorkItem(c, who.accountId, who.workItemId));
    let entry = await read();
    if (!entry) return { state: "missing" };
    if (entry.state === "awaiting_work" && entry.workKind === "delta_review") {
      const github = await openQueueGitHub(pool, openInstallationHttp, entry);
      const done = github ? await bindCompleteDeltaReview({ pool, worker, open: openInstallationHttp, github })(entry) : null;
      // A passed review put the entry back in the queue: the tick has work again. Nothing else wakes the cron (no standing poll).
      if (done?.outcome === "passed") await markWorkPending("merge-queue-sweep");
      entry = (await read()) ?? entry;
    }
    switch (entry.state) {
      case "merged":
      case "in_review":
      case "closed":
      case "cancelled":
        return { state: entry.state };
      case "stopped":
        return { state: "stopped", reason: entry.reason ?? "merge_stopped" };
      default:
        return { state: "waiting" };
    }
  });
}
