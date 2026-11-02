import type { Pool } from "pg";
import { markWorkPending } from "@fx/core/src/pendingWork.js";
import { readStackParentPull } from "@fx/core/src/work-items/stackParentPull.js";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { expectedSignalNames, loadReviewContext, mergeQueue, readPublicPullRequest } from "@fx/pipeline";
import { bindCompleteConflictRound, bindCompleteEntryless, endRoundWithoutPr, entrylessStartPorts, readEntrylessSubject, runnerStartPorts } from "./mergeQueueConflict";
import { bindCompleteDeltaReview } from "./mergeQueueDeltaReview";
import { openQueueGitHub } from "./mergeQueue";
import { openInstallationHttp } from "./github/installationHttp";
import { mergeGateBody, type GateOut, type ReviewWorker } from "./advanceReviewSteps";
import type { StepWho } from "./advanceStageSteps";

/**
 * D#519 MQ3-b-2b: the workflow's two steps against the merge queue (apps/web/workflows/workItemAdvance.ts holds the directives).
 *
 *  - `enqueueBody`: after every required reviewer passed, a HOSTED, UNPAIRED item goes into its repo's queue instead of calling the gate itself.
 *    A paired item (its merge belongs to the public plane's order), a `runner_local` one, a stacked child whose parent has no queue entry (D#598 P3c), a halted item, or a worker without a
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
    // D#598 P3c (C24): a stacked child is queued behind its parent only when the parent's pull request is known AND the queue has an entry for it (any state, same repo).
    // Otherwise the direct gate stops it with `stacked_on_open_pr`, as before: an entry whose parent never gets one would wait for ever.
    const parent = await withTenant(pool, who.accountId, (c) => readStackParentPull(c, who.workItemId));
    const dependsOnPrNumber = parent === null ? null : parent.prNumber;
    if (parent !== null && (dependsOnPrNumber === null || parent.parentRepoId !== loaded.ctx.repoId || !(await withTenant(pool, who.accountId, (c) => mergeQueue.hasEntryForPr(c, who.accountId, loaded.ctx.repoId, dependsOnPrNumber))))) return null;
    // `approved_at` is stamped here the first time and never again: an existing entry keeps its own.
    const entry = await withTenant(pool, who.accountId, (c) =>
      mergeQueue.enqueueEntry(c, { accountId: who.accountId, repoId: loaded.ctx.repoId, workItemId: who.workItemId, prNumber: input.prNumber, headSha: input.headSha, dependsOnPrNumber, approvedAt: new Date() }),
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
    // D#519 MQ4-c: a merge-conflict fix round that has ended moves on (to its delta review, back to review, or to a person); one that conflicts again may be
    // back in the queue, and the tick has work for it. The delta review it starts is then followed in the same look.
    if (entry.state === "awaiting_work" && (entry.workKind === "conflict" || entry.workKind === "renumber")) {
      const github = await openQueueGitHub(pool, openInstallationHttp, entry);
      if (github) await bindCompleteConflictRound({ pool, worker, open: openInstallationHttp, github })(entry);
      entry = (await read()) ?? entry;
      if (entry.state === "queued") await markWorkPending("merge-queue-sweep");
    }
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

/**
 * D#519 MQ4-e1-a: the direct gate answered `merge_conflict` for an item with no queue entry. `not_applicable`: this is not the path for the item (a public copy, no repository
 * the cloud reads, no worker): the existing stop stands. `started`/`running`/`waiting`: a round is open or will be asked for again; `stopped`: the decision stopped it.
 */
export type ConflictStartOut = { state: "not_applicable" | "started" | "running" | "waiting" | "halted" } | { state: "stopped"; reason: string };

export async function conflictStartBody(worker: QueueWorker | null, who: StepWho): Promise<ConflictStartOut> {
  if (!worker?.withRunnerPool) return { state: "not_applicable" };
  return worker.withRunnerPool(async (pool) => {
    if ((await haltState(pool, who)).stale) return { state: "halted" };
    const base = { pool, worker, open: openInstallationHttp };
    const subject = await readEntrylessSubject(base, who.accountId, who.workItemId);
    if (!("id" in subject)) return { state: "not_applicable" };
    const github = await openQueueGitHub(pool, openInstallationHttp, subject);
    if (!github) return { state: "not_applicable" };
    const out = await mergeQueue.startEntrylessConflict(entrylessStartPorts({ ...base, github }), subject);
    return out.outcome === "stopped" ? { state: "stopped", reason: out.reason } : { state: out.outcome };
  });
}

/**
 * Held off until the end of a `runner_local` round is built (MQ4-e2-c): a round started now would never end, because the completion needs the hosted client a runner_local repository
 * does not have, so the gate would stay blocked. Flip it in that row.
 */
export const RUNNER_CONFLICT_START_ENABLED = false;

/**
 * D#519 MQ4-e2-b: the runner refused the merge call of a paired `runner_local` item's public pull request (405) and attested a conflict; the cloud kept the verdict on the order it
 * ended. The round is decided from those stored facts alone and started on the item's own (runner) target; `conflict_foreign` is the item-22 stop. `not_applicable`: the latest
 * order carries no verdict (an old runner, `unknown`, or any other end), or the item's private head is no longer the head the order was reviewed at: today's stop stands.
 * The paths are the runner's true content conflicts, narrower than the hosted decision's "changed on both sides".
 */
export async function runnerConflictBody(worker: QueueWorker | null, who: StepWho, startEnabled: boolean = RUNNER_CONFLICT_START_ENABLED): Promise<ConflictStartOut> {
  if (!worker?.withRunnerPool) return { state: "not_applicable" };
  return worker.withRunnerPool(async (pool) => {
    if ((await haltState(pool, who)).stale) return { state: "halted" };
    const order = await withTenant(pool, who.accountId, async (c) =>
      (
        await c.query<{ state: string; reviewed_head: string; conflict_verdict: "conflict_platform" | "conflict_foreign" | null; conflict_base_sha: string | null; conflict_base_ref: string | null; conflict_files: string[] | null }>(
          `SELECT state, reviewed_head, conflict_verdict, conflict_base_sha, conflict_base_ref, conflict_files FROM plane_merge_orders WHERE account_id = $1 AND work_item_id = $2 ORDER BY created_at DESC, id DESC LIMIT 1`,
          [who.accountId, who.workItemId],
        )
      ).rows[0],
    );
    if (!order || order.state !== "failed" || order.conflict_verdict === null || order.conflict_base_sha === null || order.conflict_base_ref === null || order.conflict_files === null) return { state: "not_applicable" };
    const base = { pool, worker, open: openInstallationHttp };
    const subject = await readEntrylessSubject(base, who.accountId, who.workItemId);
    // The verdict describes the private head the order was reviewed at; a head that moved since is judged afresh by the review loop.
    if (!("id" in subject) || subject.headSha !== order.reviewed_head) return { state: "not_applicable" };
    if (!startEnabled && order.conflict_verdict === "conflict_platform") {
      // Held: no round starts, so the item stops as a conflict with the stored detail, for a person (the foreign stop and the stored verdict stay live).
      await mergeQueue.recordStop(runnerStartPorts(base), subject, "round_not_started", subject.headSha, "merge_conflict", { baseRef: order.conflict_base_ref, conflictFiles: order.conflict_files });
      return { state: "stopped", reason: "merge_conflict" };
    }
    const out = await mergeQueue.startEntrylessFromRunnerFacts(runnerStartPorts(base), subject, { verdict: order.conflict_verdict, baseSha: order.conflict_base_sha, baseRef: order.conflict_base_ref, files: order.conflict_files });
    return out.outcome === "stopped" ? { state: "stopped", reason: out.reason } : { state: out.outcome };
  });
}

/** One look at the item's round with no queue entry, moving it on (see `completeEntrylessRound`). `in_review`: the review loop reads the head again. `passed`: the delta review passed. */
export type ConflictWaitOut = { state: "passed"; headSha: string } | { state: "waiting" | "in_review" | "halted" | "none" | "merged" | "closed" } | { state: "stopped"; reason: string };

export async function conflictWaitBody(worker: QueueWorker | null, who: StepWho): Promise<ConflictWaitOut> {
  if (!worker?.withRunnerPool) return { state: "none" };
  return worker.withRunnerPool(async (pool) => {
    if ((await haltState(pool, who)).stale) return { state: "halted" };
    const base = { pool, worker, open: openInstallationHttp };
    const subject = await readEntrylessSubject(base, who.accountId, who.workItemId, true);
    // A lookup that failed is asked again on the next poll; a pull request that is confirmed gone, with nothing recorded to read, ends the round.
    if (!("id" in subject) && subject.reason === "try_later") return { state: "waiting" };
    if (!("id" in subject) && subject.reason === "no_open_pr") return (await endRoundWithoutPr(base, who.accountId, who.workItemId)) ? { state: "closed" } : { state: "none" };
    if (!("id" in subject)) return { state: "none" };
    const github = await openQueueGitHub(pool, openInstallationHttp, subject);
    if (!github) return { state: "none" };
    const done = await bindCompleteEntryless({ ...base, github })(subject);
    switch (done.outcome) {
      case "returned":
        return { state: "in_review" };
      case "stopped":
        return { state: "stopped", reason: done.reason };
      case "settled":
        return { state: done.as };
      case "passed":
        return { state: "passed", headSha: subject.headSha };
      case "not_waiting":
        return { state: "none" };
      default:
        return { state: "waiting" };
    }
  });
}

/**
 * D#519 MQ4-e1-a: the direct gate asked again for the merge commit a conflict round produced. Like the queue tick, it must show every CI signal the FIRST round's pre-round head
 * showed (the platform's own review status alone is no CI), and a head with nothing to compare against never reads as green: the answer is then `ci_not_green` without the gate
 * being run, and the workflow's bounded wait asks again.
 */
export async function conflictGateBody(worker: QueueWorker | null, who: StepWho, prNumber: number): Promise<GateOut> {
  const expected = worker?.withRunnerPool
    ? await worker.withRunnerPool(async (pool): Promise<string[] | null> => {
        const subject = await readEntrylessSubject({ pool, worker, open: openInstallationHttp }, who.accountId, who.workItemId);
        const github = "id" in subject ? await openQueueGitHub(pool, openInstallationHttp, subject) : null;
        if (!("id" in subject) || !github) return null;
        const rounds = (await withTenant(pool, who.accountId, (c) => mergeQueue.listConflictRounds(c, who.accountId, who.workItemId))).filter((r) => r.entryId === null);
        let origin = [...rounds].reverse().find((r) => r.toSha !== null);
        // A later round starts from the earlier round's merge commit: walk back to the head the chain began at.
        for (let hops = 0; origin !== undefined && hops < rounds.length; hops += 1) {
          const prev = rounds.find((r) => r.id !== origin!.id && r.toSha === origin!.fromSha);
          if (prev === undefined) break;
          origin = prev;
        }
        return origin === undefined ? null : expectedSignalNames(await github.getCiSnapshot({ repoId: subject.repoId, prNumber }, origin.fromSha));
      })
    : null;
  if (expected === null || expected.length === 0) return { outcome: "ready_human_merges", reasons: ["ci_not_green"], status: null, headSha: null };
  return mergeGateBody(worker, who, prNumber, expected);
}
