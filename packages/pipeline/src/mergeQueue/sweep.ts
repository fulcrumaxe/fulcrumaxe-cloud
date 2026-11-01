import type { Pool, PoolClient } from "pg";
import { reportError } from "@fx/telemetry";
import { MERGE_QUEUE_RECONCILE_READS_PER_SWEEP, MERGE_QUEUE_SWEEP_LIMIT } from "./policy.js";
import { reclaimExpiredLeases } from "./store.js";
import type { MergeQueueEntry } from "./types.js";

/**
 * D#519 MQ2: the sweep behind a crashed queue step. It finds the repos that need attention (a slot whose lease has lapsed, or queued
 * entries and nobody holding the slot), returns every lapsed lease to the queue at the entry's original position, and hands each repo
 * to the queue tick (MQ3) so the next eligible entry gets the slot.
 *
 * Cross-tenant only for the LIST, which is a database function (`merge_queue_sweep_targets`, migration 0824) that answers repo ids and
 * nothing else and is executable by the run-writer login alone. Every write after that runs inside that repo's own tenant transaction.
 * The sweep leases nothing itself: reclaiming is a compare-and-set on the entry, so two sweeps, or a sweep and a tick, cannot both
 * end with a holder. The route that calls it is MQ3's (it reuses CRON_SECRET; no new setting).
 */

export interface SweepTarget {
  accountId: string;
  repoId: string;
}

export interface MergeQueueSweepDeps {
  /** The repos to look at, oldest-touched first. Production: `listMergeQueueSweepTargets` over the run-writer pool. */
  listTargets(now: Date | undefined, limit: number): Promise<SweepTarget[]>;
  /** Runs `fn` in a tenant transaction for the account (`withTenant`). */
  inTenant<T>(accountId: string, fn: (client: PoolClient) => Promise<T>): Promise<T>;
  /** The queue tick for one repo, after its lapsed leases were reclaimed. MQ3 supplies it; absent, the sweep only reclaims. */
  tick?(target: SweepTarget, reclaimed: readonly MergeQueueEntry[]): Promise<void>;
  /**
   * D#694 B6-4: the bounded reconcile of entries waiting in the host's queue (reconcile.ts), run for each repo before its tick. `maxReads` is what is left of the sweep's
   * GitHub reads (`reconcileReads`, default MERGE_QUEUE_RECONCILE_READS_PER_SWEEP); it answers how many it made. A throw is reported and never stops the tick.
   */
  reconcile?(target: SweepTarget, maxReads: number): Promise<{ reads: number; settled: number; escalated: number }>;
  reconcileReads?: number;
  /** Injectable clock; left out, the database's clock decides what has lapsed. */
  now?: Date;
  limit?: number;
}

export interface MergeQueueSweepResult {
  /** Repos the list returned. */
  listed: number;
  /** Entries whose lapsed lease was returned to the queue. */
  reclaimed: number;
  /** Repos handed to the tick. */
  ticked: number;
  /** Repos whose reclaim or tick threw; reported, and listed again by the next sweep. */
  failed: number;
  /** Only when the sweep reconciles (B6-4): GitHub reads made, entries settled, and items handed to a person. */
  reconcileReads?: number;
  reconciled?: number;
  reconcileEscalated?: number;
}

export async function sweepMergeQueue(deps: MergeQueueSweepDeps): Promise<MergeQueueSweepResult> {
  const out: MergeQueueSweepResult = { listed: 0, reclaimed: 0, ticked: 0, failed: 0 };
  const targets = await deps.listTargets(deps.now, deps.limit ?? MERGE_QUEUE_SWEEP_LIMIT);
  out.listed = targets.length;
  let readsLeft = deps.reconcileReads ?? MERGE_QUEUE_RECONCILE_READS_PER_SWEEP;
  if (deps.reconcile) Object.assign(out, { reconcileReads: 0, reconciled: 0, reconcileEscalated: 0 });
  for (const target of targets) {
    try {
      const reclaimed = await deps.inTenant(target.accountId, (client) =>
        reclaimExpiredLeases(client, { accountId: target.accountId, repoId: target.repoId, now: deps.now }),
      );
      out.reclaimed += reclaimed.length;
      if (deps.reconcile && readsLeft > 0) {
        try {
          const r = await deps.reconcile(target, readsLeft);
          readsLeft -= r.reads;
          out.reconcileReads! += r.reads;
          out.reconciled! += r.settled;
          out.reconcileEscalated! += r.escalated;
        } catch (err) {
          // fx-swallow-ok: reported; the backstop must not stop the tick it exists beside, and the next sweep reads again
          reportError(err, { stage: "merge_queue.reconcile" });
        }
      }
      if (deps.tick) {
        await deps.tick(target, reclaimed);
        out.ticked += 1;
      }
    } catch (err) {
      // One repo that would not sweep must not hold back the rest; the next sweep lists it again.
      out.failed += 1;
      reportError(err, { stage: "merge_queue.sweep" });
    }
  }
  return out;
}

/**
 * The production lister: the database function over the run-writer login's pool. Ids only. `now` left out means the database's clock.
 */
export async function listMergeQueueSweepTargets(runWriterPool: Pick<Pool, "query">, now: Date | undefined, limit: number): Promise<SweepTarget[]> {
  const { rows } = await runWriterPool.query<{ account_id: string; repo_id: string }>(
    `SELECT account_id, repo_id FROM merge_queue_sweep_targets(COALESCE($1::timestamptz, now()), $2::int)`,
    [now ?? null, limit],
  );
  return rows.map((r) => ({ accountId: r.account_id, repoId: r.repo_id }));
}
