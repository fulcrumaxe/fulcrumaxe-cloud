import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { markWorkPending } from "@fx/core/src/pendingWork.js";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { reclaimExpiredLeases } from "./store.js";

/**
 * D#483 S5-j2a1: the per-repository merge lease. A direct merge (the merge gate) and the merge queue's slot exclude each other on one repository.
 *
 * The rule is one rule with two checks. Each check runs under the same `pg_advisory_xact_lock`, keyed on the repository, in its own short transaction:
 *  - the gate takes a lease only while no entry of the repository is `in_flight` and no other live lease exists (`acquireMergeLease`);
 *  - the queue's `takeSlot` takes the slot only while no live lease exists (`hasLiveMergeLease`, read after `lockRepoMerge`).
 * So of a gate and a tick racing for one repository, one wins and the other sees it. A lease past `lease_until` is dead; the next taker overwrites it. There is no
 * cleanup job: a gate that died holds nothing for longer than the lease.
 */

/** The default lease of a direct merge: the longest a gate run may take before another taker may overwrite it. */
export const DIRECT_MERGE_LEASE_SECONDS = 600;
export type MergeLeaseKind = "direct" | "order";

type Queryable = Pick<PoolClient, "query">;

/** Serializes the lease check and the slot check of one repository until the surrounding transaction ends. Must run inside a transaction: outside one, the lock is dropped at once. */
export async function lockRepoMerge(client: Queryable, accountId: string, repoId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`repo_merge:${accountId}:${repoId}`]);
}

/** Whether a lease of the repository is live at `now` (the database's clock when absent). Call after `lockRepoMerge`, in the same transaction, for the answer to hold. */
export async function hasLiveMergeLease(client: Queryable, input: { accountId: string; repoId: string; now?: Date }): Promise<boolean> {
  const { rows } = await client.query(`SELECT 1 FROM repo_merge_leases WHERE account_id = $1 AND repo_id = $2 AND lease_until > COALESCE($3::timestamptz, now())`, [
    input.accountId,
    input.repoId,
    input.now ?? null,
  ]);
  return rows.length > 0;
}

export interface MergeLeaseInput {
  accountId: string;
  repoId: string;
  kind?: MergeLeaseKind;
  holder?: string;
  leaseSeconds?: number;
  now?: Date;
}

export type MergeLeaseTake = { taken: true; holder: string; release(): Promise<void> } | { taken: false };

/**
 * Takes the repository's merge lease, or answers `taken: false` (busy) while a live lease or an `in_flight` queue entry of the repository exists. An expired lease is
 * overwritten by the taker. The check and the write are one short transaction under the repository's advisory lock.
 */
export async function acquireMergeLease(pool: Pool, input: MergeLeaseInput): Promise<MergeLeaseTake> {
  const leaseSeconds = input.leaseSeconds ?? DIRECT_MERGE_LEASE_SECONDS;
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 86_400) throw new Error("merge lease: bad lease length");
  const holder = input.holder ?? `lease-${randomUUID()}`;
  const took = await withTenant(pool, input.accountId, async (client) => {
    await lockRepoMerge(client, input.accountId, input.repoId);
    // An entry whose slot lease has lapsed (a tick that died) is not a holder: the queue's own rule returns it to `queued`, here as in `takeSlot`. A live one blocks.
    await reclaimExpiredLeases(client, { accountId: input.accountId, repoId: input.repoId, ...(input.now ? { now: input.now } : {}) });
    const slot = await client.query(`SELECT 1 FROM merge_queue_entries WHERE account_id = $1 AND repo_id = $2 AND state = 'in_flight' LIMIT 1`, [input.accountId, input.repoId]);
    if (slot.rows.length > 0) return false;
    // The conflict update only overwrites a dead lease; a live one returns no row.
    const res = await client.query(
      `INSERT INTO repo_merge_leases (account_id, repo_id, holder, kind, lease_until)
       VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, now()) + make_interval(secs => $6))
       ON CONFLICT (account_id, repo_id) DO UPDATE
         SET holder = EXCLUDED.holder, kind = EXCLUDED.kind, lease_until = EXCLUDED.lease_until
         WHERE repo_merge_leases.lease_until <= COALESCE($5::timestamptz, now())
       RETURNING holder`,
      [input.accountId, input.repoId, holder, input.kind ?? "direct", input.now ?? null, leaseSeconds],
    );
    return res.rows.length > 0;
  });
  if (!took) return { taken: false };
  return { taken: true, holder, release: () => releaseMergeLease(pool, { accountId: input.accountId, repoId: input.repoId, holder }) };
}

/**
 * Frees the lease the named holder took. A lease another taker has since overwritten (this one expired) is left alone. Never throws for a missing row. A database failure
 * here is reported and swallowed on purpose: the lease then lapses by its own `lease_until`, and a throw would replace the merge outcome the caller is returning.
 */
export async function releaseMergeLease(pool: Pool, input: { accountId: string; repoId: string; holder: string }): Promise<void> {
  try {
    const wake = await withTenant(pool, input.accountId, async (client) => {
      const freed = await client.query(`DELETE FROM repo_merge_leases WHERE account_id = $1 AND repo_id = $2 AND holder = $3`, [input.accountId, input.repoId, input.holder]);
      if (freed.rowCount === 0) return false;
      const waiting = await client.query(`SELECT 1 FROM merge_queue_entries WHERE account_id = $1 AND repo_id = $2 AND state = 'queued' LIMIT 1`, [input.accountId, input.repoId]);
      return waiting.rows.length > 0;
    });
    // A queued entry was waiting on this lease: mark the merge-queue sweep as having work, so it ticks the repository now and not at the next backstop slot.
    if (wake) await markWorkPending("merge-queue-sweep");
  } catch (err) {
    // fx-swallow-ok: reported with a fixed code; the lease expires by itself and the merge outcome must not be lost
    console.warn(JSON.stringify({ event: "merge_lease.release_failed", name: typeof (err as { name?: unknown })?.name === "string" ? (err as { name: string }).name.slice(0, 60) : null }));
  }
}
