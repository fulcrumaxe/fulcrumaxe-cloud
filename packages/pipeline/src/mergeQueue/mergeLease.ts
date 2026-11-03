import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { markWorkPending } from "@fx/core/src/pendingWork.js";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { recordDriverEvent } from "@fx/core/src/work-items/driverEvents.js";
import { reportError } from "@fx/telemetry";
import type { QueueEntryReading } from "../build/mergeGate.js";
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

/** The longest a hold for GitHub's queue can last, whatever is read or not: 24 hours. A repository that can no longer be read has bigger problems. */
export const HOST_QUEUE_MAX_AGE_MINUTES = 1440;
const HOLDER_SQL = "^ghq:[0-9]{1,9}:[0-9]{1,15}:[0-9]{1,12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(:u[0-9]{1,3})?$";

/**
 * D#483 S5-j2c1: the lease of a runner's merge order (kind `order`) is held until the order ends. Its holder names the order and the minute it began, `ord:<order id>:<start minute>`: digits, colons and a uuid, a fixed length.
 * It is live while the order is open (a read of the order's own row, `pending`, `claimed` or `authorized`) or `enqueued` (the runner put the pull request in GitHub's queue: the hold is converted to a `ghq:` hold
 * by `convertOrderLeaseToHostQueue`, and until it is, this one stays) and within the 24-hour bound: a timer alone never ends it, and an order that cannot be read keeps the repository busy.
 */
const ORDER_HOLDER_SQL = "^ord:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]{1,12}$";
/** A holder that says it is a hold (`ghq:`) or a runner's order (`ord:`) but is not well formed fails closed: it keeps the repository busy for 24 hours after its `lease_until`, which nothing renews, and then ends like any lapsed lease. */
const MALFORMED_SQL = `((holder LIKE 'ghq:%' AND holder !~ '${HOLDER_SQL}') OR (holder LIKE 'ord:%' AND holder !~ '${ORDER_HOLDER_SQL}'))`;
const orderHoldOpenSql = (now: string, bound: string): string =>
  `(EXISTS (SELECT 1 FROM plane_merge_orders o WHERE o.account_id = repo_merge_leases.account_id AND o.id::text = split_part(holder, ':', 2) AND o.state IN ('pending', 'claimed', 'authorized', 'enqueued'))
     AND extract(epoch FROM ${now}) / 60 - split_part(holder, ':', 3)::bigint < ${bound})`;
export const orderHolder = (orderId: string, now: Date = new Date()): string => {
  const holder = `ord:${orderId.toLowerCase()}:${Math.floor(now.getTime() / 60_000)}`;
  if (!new RegExp(ORDER_HOLDER_SQL).test(holder)) throw new Error("merge lease: bad order id");
  return holder;
};

/** Whether a lease of the repository is live at `now` (the database's clock when absent). Call after `lockRepoMerge`, in the same transaction, for the answer to hold. */
export async function hasLiveMergeLease(client: Queryable, input: { accountId: string; repoId: string; now?: Date }): Promise<boolean> {
  // A hold for GitHub's queue (`ghq:`) is live whether lapsed or not (D#483 S5-j2a2, R-C35): the tick has no read port, so only a gate's read, the settle or the sweep's read frees it,
  // or its 24 hours.
  const { rows } = await client.query(
    `SELECT 1 FROM repo_merge_leases WHERE account_id = $1 AND repo_id = $2
        AND ((lease_until > COALESCE($3::timestamptz, now()) AND holder !~ '${ORDER_HOLDER_SQL}')
             OR CASE WHEN holder ~ '${HOLDER_SQL}' THEN extract(epoch FROM COALESCE($3::timestamptz, now())) / 60 - split_part(holder, ':', 4)::bigint < $4
                     WHEN ${MALFORMED_SQL} THEN lease_until + make_interval(mins => $4::int) > COALESCE($3::timestamptz, now())
                     WHEN holder ~ '${ORDER_HOLDER_SQL}' THEN ${orderHoldOpenSql("COALESCE($3::timestamptz, now())", "$4")}
                     ELSE false END)`,
    [input.accountId, input.repoId, input.now ?? null, HOST_QUEUE_MAX_AGE_MINUTES],
  );
  return rows.length > 0;
}

/** What GitHub says of the pull request a `ghq:` hold was taken for: still waiting, gone from the queue, or not readable. Only `gone` lets a lapsed hold be overwritten. */
export type HostQueueEntryState = "queued" | "gone" | "unreadable";

export interface MergeLeaseInput {
  accountId: string;
  repoId: string;
  kind?: MergeLeaseKind;
  holder?: string;
  leaseSeconds?: number;
  now?: Date;
  /** D#483 S5-j2a2 (R-C35-2): reads the queue entry of a lapsed `ghq:` hold's pull request. Absent, the hold is read as unreadable: it stays. */
  hostQueueEntry?(prNumber: number, repoGhId: string, workItemId: string): Promise<HostQueueEntryState>;
}

export type MergeLeaseTake =
  | { taken: false; stuck?: true }
  | { taken: true; holder: string; kind: MergeLeaseKind; release(): Promise<void>; holdForHostQueue(prNumber: number, repoGhId: string | null, workItemId: string): Promise<void>; confirm(): Promise<boolean> };

/**
 * Takes the repository's merge lease, or answers `taken: false` (busy) while a live lease or an `in_flight` queue entry of the repository exists. An expired lease is
 * overwritten by the taker, except a lapsed `ghq:` hold: that timer only triggers a read of the pull request's queue entry (R-C35-2). Still waiting or unreadable renews the hold and
 * answers busy; settled lets the taker take it. Each check and write is one short transaction under the repository's advisory lock; the GitHub read sits between two of them.
 */
export async function acquireMergeLease(pool: Pool, input: MergeLeaseInput): Promise<MergeLeaseTake> {
  const leaseSeconds = input.leaseSeconds ?? DIRECT_MERGE_LEASE_SECONDS;
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 86_400) throw new Error("merge lease: bad lease length");
  const holder = input.holder ?? `lease-${randomUUID()}`;
  type Step = "taken" | "busy" | "stuck" | { read: { holder: string; prNumber: number; repoGhId: string; startMin: number; workItemId: string } };
  const attempt = (verdict?: { holder: string; state: HostQueueEntryState }): Promise<Step> =>
    withTenant(pool, input.accountId, async (client): Promise<Step> => {
      await lockRepoMerge(client, input.accountId, input.repoId);
      // An entry whose slot lease has lapsed (a tick that died) is not a holder: the queue's own rule returns it to `queued`, here as in `takeSlot`. A live one blocks.
      await reclaimExpiredLeases(client, { accountId: input.accountId, repoId: input.repoId, ...(input.now ? { now: input.now } : {}) });
      const slot = await client.query(`SELECT 1 FROM merge_queue_entries WHERE account_id = $1 AND repo_id = $2 AND state = 'in_flight' LIMIT 1`, [input.accountId, input.repoId]);
      if (slot.rows.length > 0) return "busy";
      const cur = (await client.query<{ holder: string; expired: boolean; now_min: string; malformed_live: boolean; order_live: boolean | null }>(
        `SELECT holder, lease_until <= COALESCE($3::timestamptz, now()) AS expired, floor(extract(epoch FROM COALESCE($3::timestamptz, now())) / 60)::bigint AS now_min,
                (${MALFORMED_SQL} AND lease_until + make_interval(mins => $4::int) > COALESCE($3::timestamptz, now())) AS malformed_live,
                CASE WHEN holder ~ '${ORDER_HOLDER_SQL}' THEN ${orderHoldOpenSql("COALESCE($3::timestamptz, now())", "$4")} ELSE NULL END AS order_live
           FROM repo_merge_leases WHERE account_id = $1 AND repo_id = $2`,
        [input.accountId, input.repoId, input.now ?? null, HOST_QUEUE_MAX_AGE_MINUTES],
      )).rows[0];
      if (cur?.malformed_live === true) return "busy";
      // A runner's order holds the repository while the order is open, whatever the clock says; once the order is over (or past 24 hours) its row is dead and is cleared here, under the lock.
      if (cur?.order_live === true) return "busy";
      if (cur?.order_live === false) await client.query(`DELETE FROM repo_merge_leases WHERE account_id = $1 AND repo_id = $2 AND holder = $3`, [input.accountId, input.repoId, cur.holder]);
      const held = cur?.expired ? parseHostQueueHolder(cur.holder) : null;
      if (cur !== undefined && held !== null && Number(cur.now_min) - held.startMin >= HOST_QUEUE_MAX_AGE_MINUTES) {
        // 24 hours is the bound whatever else is true: the hold ends, with a recorded event on the item it was held for and a visible note.
        await recordHoldEnded(client, { accountId: input.accountId, repoId: input.repoId, prNumber: held.prNumber, startMin: held.startMin, workItemId: held.workItemId });
      } else if (cur !== undefined && held !== null) {
        if (verdict === undefined || verdict.holder !== cur.holder) return { read: { holder: cur.holder, ...held } };
        if (verdict.state !== "gone") {
          // Still in the queue: renewed, and the count of unreadable reads starts again. Unreadable: counted in the holder; the third in a row is put before a person and rechecked soon.
          const base = `ghq:${held.prNumber}:${held.repoGhId}:${held.startMin}:${held.workItemId}`;
          const misses = verdict.state === "unreadable" ? Math.min(held.misses + 1, 999) : 0;
          const stuck = misses >= HOST_QUEUE_UNREADABLE_LIMIT;
          await client.query(`UPDATE repo_merge_leases SET holder = $6, lease_until = COALESCE($4::timestamptz, now()) + make_interval(secs => $5) WHERE account_id = $1 AND repo_id = $2 AND holder = $3`, [
            input.accountId,
            input.repoId,
            cur.holder,
            input.now ?? null,
            stuck ? HOST_QUEUE_STUCK_RECHECK_SECONDS : HOST_QUEUE_LEASE_SECONDS,
            misses > 0 ? `${base}:u${misses}` : base,
          ]);
          return stuck ? "stuck" : "busy";
        }
      }
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
      return res.rows.length > 0 ? "taken" : "busy";
    });
  let step = await attempt();
  if (typeof step === "object") {
    const lapsed = step.read;
    let state: HostQueueEntryState = "unreadable";
    try {
      if (input.hostQueueEntry) state = await input.hostQueueEntry(lapsed.prNumber, lapsed.repoGhId, lapsed.workItemId);
    } catch (err) {
      reportError(err, { stage: "merge_lease.host_queue_entry" });
    }
    step = await attempt({ holder: lapsed.holder, state });
  }
  if (step === "stuck") return { taken: false, stuck: true };
  if (step !== "taken") return { taken: false };
  const where = { accountId: input.accountId, repoId: input.repoId, holder };
  return {
    taken: true,
    holder,
    kind: input.kind ?? "direct",
    release: () => releaseMergeLease(pool, where),
    holdForHostQueue: (prNumber, repoGhId, workItemId) => holdLeaseForHostQueue(pool, { ...where, prNumber, repoGhId, workItemId }),
    confirm: () => confirmMergeLease(pool, { ...where, seconds: leaseSeconds }),
  };
}

/**
 * D#483 S5-j2a2 (R-C35-5): renews the lease and answers whether this holder still has it, immediately before the merge call. False when it was taken over, deleted, or a queue slot is
 * in flight on the repository, or the lease had lapsed (nobody overwrote it, but a tick may have come and gone). A database failure is false too: nothing merges on a doubt.
 */
export async function confirmMergeLease(pool: Pool, input: { accountId: string; repoId: string; holder: string; seconds?: number }): Promise<boolean> {
  try {
    return await withTenant(pool, input.accountId, async (client) => {
      await lockRepoMerge(client, input.accountId, input.repoId);
      const res = await client.query(
        `UPDATE repo_merge_leases SET lease_until = now() + make_interval(secs => $4)
          WHERE account_id = $1 AND repo_id = $2 AND holder = $3 AND lease_until > now()
            AND NOT EXISTS (SELECT 1 FROM merge_queue_entries e WHERE e.account_id = $1 AND e.repo_id = $2 AND e.state = 'in_flight')
        RETURNING holder`,
        [input.accountId, input.repoId, input.holder, input.seconds ?? DIRECT_MERGE_LEASE_SECONDS],
      );
      return res.rows.length > 0;
    });
  } catch (err) {
    reportError(err, { stage: "merge_lease.confirm" });
    return false;
  }
}

/**
 * D#483 S5-j2c1 (R-C34-F4, R-C35-2, R-C35-4): an order that ended `enqueued` (the runner put its pull request in GitHub's queue) turns the order lease into the same `ghq:` hold a direct gate takes, named by the
 * PUBLIC pull request's number and the code repository's id, so the webhook's settle frees it and a lapsed one is read against the queue entry. Never throws and never frees: when the write fails (or finds no
 * order lease) the order lease stays, live because its order row says `enqueued`, until its own 24-hour bound. Answers whether the conversion happened.
 */
export async function convertOrderLeaseToHostQueue(pool: Pool, input: { accountId: string; repoId: string; orderId: string; prNumber: number; repoGhId: string | null; workItemId: string; seconds?: number }): Promise<boolean> {
  try {
    return await withTenant(pool, input.accountId, async (client) => {
      await lockRepoMerge(client, input.accountId, input.repoId);
      const res = await client.query(
        `UPDATE repo_merge_leases SET kind = 'direct', holder = 'ghq:' || $4::text || ':' || $5::text || ':' || (floor(extract(epoch FROM now()) / 60))::bigint::text || ':' || $7::text, lease_until = now() + make_interval(secs => $6)
          WHERE account_id = $1 AND repo_id = $2 AND holder ~ '${ORDER_HOLDER_SQL}' AND split_part(holder, ':', 2) = $3::text
        RETURNING holder`,
        [input.accountId, input.repoId, input.orderId.toLowerCase(), input.prNumber, idPart(input.repoGhId), input.seconds ?? HOST_QUEUE_LEASE_SECONDS, input.workItemId],
      );
      return res.rows.length > 0;
    });
  } catch (err) {
    // fx-swallow-ok: reported with a fixed line; the order lease stays and still excludes (its order row says enqueued), so the enqueue is not lost and nothing is freed on a doubt
    console.warn(JSON.stringify({ event: "merge_lease.convert_failed", name: typeof (err as { name?: unknown })?.name === "string" ? (err as { name: string }).name.slice(0, 60) : null }));
    return false;
  }
}

/** D#483 S5-j2a2 (R-C35-2): how long a hold for GitHub's merge queue lasts before the pull request's queue entry is read again. */
export const HOST_QUEUE_LEASE_SECONDS = 1800;
/** The third unreadable read of one hold in a row stops renewing it silently: the asking item is shown `ordered_resource_unreadable`, and the hold is read again after this many seconds. */
export const HOST_QUEUE_UNREADABLE_LIMIT = 3;
export const HOST_QUEUE_STUCK_RECHECK_SECONDS = 300;
/**
 * The holder names the pull request, the repository's numeric GitHub id (stable across renames, and what a webhook carries as `repository.id`), the minute the hold began (its 24-hour
 * bound), the work item the hold is for (so its facts are found by item, not by a pull request number), and `:u<n>` once n unreadable reads in a row have renewed it. Digits and colons only, so it is a fixed small length and `5` can never match `55`.
 */
const idPart = (repoGhId: string | number | null): string => (/^[0-9]{1,15}$/.test(String(repoGhId)) ? String(repoGhId) : "0");
const parseHostQueueHolder = (holder: string): { prNumber: number; repoGhId: string; startMin: number; workItemId: string; misses: number } | null => {
  const m = /^ghq:(\d{1,9}):(\d{1,15}):(\d{1,12}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?::u(\d{1,3}))?$/.exec(holder);
  return m ? { prNumber: Number(m[1]), repoGhId: m[2]!, startMin: Number(m[3]), workItemId: m[4]!, misses: m[5] === undefined ? 0 : Number(m[5]) } : null;
};

/** The end of a hold at its 24-hour bound, as a fact of the item the hold names (not a pull request number, which a paired item has twice) and a note the card words. */
async function recordHoldEnded(client: Queryable, input: { accountId: string; repoId: string; prNumber: number; startMin: number; workItemId: string }): Promise<void> {
  const item = await client.query(`SELECT 1 FROM work_items WHERE account_id = $1 AND id = $2 AND repo_id = $3`, [input.accountId, input.workItemId, input.repoId]);
  if (item.rows.length === 0) return;
  await recordDriverEvent(client as PoolClient, input.accountId, { workItemId: input.workItemId, kind: "merge_gate", dedupeKey: `hold_expired:${input.prNumber}:${input.startMin}`, code: "merge_hold_expired", reasons: ["merge_hold_expired"], prNumber: input.prNumber });
}

/**
 * What a lapsed hold's pull request is doing, from the queue-entry read the caller passes: an entry in the queue (awaiting checks included) is waiting; no entry is gone, open or closed,
 * except a pull request whose enqueue was GitHub's auto-merge (the fallback of a forbidden enqueue), which has no entry until its checks pass. The read cannot tell auto-merge, so the
 * enqueue fact the platform recorded (`auto_merge`) decides, and the pull request has to be open and unmerged. A disabled auto-merge is not seen: the webhook or the 24 hours end it.
 */
export async function readHostHoldState(pool: Pool, input: { accountId: string; workItemId: string; read(): Promise<QueueEntryReading> }): Promise<HostQueueEntryState> {
  const reading = await input.read();
  if (reading.entry !== null) return "queued";
  if (reading.state !== "open" || reading.merged) return "gone";
  // The enqueue fact of the item the hold names, whatever pull request number each plane gives it.
  const last = await withTenant(pool, input.accountId, (c) =>
    c.query<{ code: string | null }>(`SELECT code FROM work_item_driver_events WHERE account_id = $1 AND work_item_id = $2 AND kind = 'merge_enqueued' ORDER BY seq DESC LIMIT 1`, [input.accountId, input.workItemId]),
  );
  return last.rows[0]?.code === "auto_merge" ? "queued" : "gone";
}

/**
 * A pull request the gate put in GitHub's merge queue, and which adds an ordered-resource file, keeps the repository's lease until the entry settles (`releaseHostQueueLease`, from the
 * webhook), or until it lapses and a read says it is gone, or 24 hours. Direct merges on the repository then go through that queue one at a time. The lease changes holder, so the gate's
 * own `release` no longer matches it. Never throws: when the write fails the gate's lease (at most `DIRECT_MERGE_LEASE_SECONDS` more) stays as it was and still excludes.
 */
export async function holdLeaseForHostQueue(pool: Pool, input: { accountId: string; repoId: string; holder: string; prNumber: number; repoGhId: string | null; workItemId: string; seconds?: number }): Promise<void> {
  try {
    await withTenant(pool, input.accountId, async (client) => {
      await lockRepoMerge(client, input.accountId, input.repoId);
      await client.query(
        `UPDATE repo_merge_leases SET holder = 'ghq:' || $4::text || ':' || $5::text || ':' || (floor(extract(epoch FROM now()) / 60))::bigint::text || ':' || $7::text, lease_until = now() + make_interval(secs => $6)
          WHERE account_id = $1 AND repo_id = $2 AND holder = $3`,
        [input.accountId, input.repoId, input.holder, input.prNumber, idPart(input.repoGhId), input.seconds ?? HOST_QUEUE_LEASE_SECONDS, input.workItemId],
      );
    });
  } catch (err) {
    // fx-swallow-ok: reported with a fixed code; the gate's own lease keeps excluding until it lapses and the merge outcome must not be lost
    console.warn(JSON.stringify({ event: "merge_lease.hold_failed", name: typeof (err as { name?: unknown })?.name === "string" ? (err as { name: string }).name.slice(0, 60) : null }));
  }
}

/** The entry of `prNumber` of the repository with GitHub id `repoGhId` (the one the webhook is about) settled in GitHub's merge queue: the lease the gate held for it, in this account, is freed. */
export async function releaseHostQueueLease(client: Queryable, input: { accountId: string; repoGhId: number | string; prNumber: number }): Promise<void> {
  await client.query(`DELETE FROM repo_merge_leases WHERE account_id = $1 AND holder LIKE 'ghq:' || $2::text || ':' || $3::text || ':%'`, [input.accountId, input.prNumber, idPart(input.repoGhId)]);
}

/**
 * The sweep's read of a lapsed hold, for a repository whose queue only has tick entries and so has no gate that would ask: the same logic as a gate's take (`acquireMergeLease`), and the
 * lease is given straight back (which wakes the queue sweep). Acts only when a lapsed `ghq:` row exists.
 */
export async function reapLapsedHostHold(pool: Pool, input: { accountId: string; repoId: string; hostQueueEntry: NonNullable<MergeLeaseInput["hostQueueEntry"]> }): Promise<void> {
  const lapsed = await withTenant(pool, input.accountId, (c) =>
    c.query(`SELECT 1 FROM repo_merge_leases WHERE account_id = $1 AND repo_id = $2 AND lease_until <= now() AND holder ~ '${HOLDER_SQL}'`, [input.accountId, input.repoId]),
  );
  if (lapsed.rows.length === 0) return;
  const take = await acquireMergeLease(pool, { accountId: input.accountId, repoId: input.repoId, hostQueueEntry: input.hostQueueEntry });
  if (take.taken) await take.release();
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
