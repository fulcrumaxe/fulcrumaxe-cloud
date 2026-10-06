import type { PoolClient } from "pg";

/**
 * Everything a refused or replayed DS-2d call must leave untouched, read
 * with the admin connection (RLS-free) for one account. Compare two of
 * these with toEqual.
 */
export interface StoreSnapshot {
  comments: number;
  discussions: number;
  workItems: number;
  revisions: number;
  nextNumber: string | null;
  bytesUsed: string | null;
  events: number;
  runEvents: number;
}

export async function snapshotStore(admin: PoolClient, accountId: string): Promise<StoreSnapshot> {
  const n = async (sql: string): Promise<number> => {
    const { rows } = await admin.query<{ n: string }>(sql, [accountId]);
    return Number(rows[0]!.n);
  };
  const { rows: counters } = await admin.query<{ next_number: string; bytes_used: string }>(
    `SELECT next_number, bytes_used FROM discussion_counters WHERE account_id = $1`,
    [accountId],
  );
  return {
    comments: await n(`SELECT count(*) AS n FROM discussion_comments WHERE account_id = $1`),
    discussions: await n(`SELECT count(*) AS n FROM discussions WHERE account_id = $1`),
    workItems: await n(`SELECT count(*) AS n FROM work_items WHERE account_id = $1`),
    revisions: await n(`SELECT count(*) AS n FROM discussion_revisions WHERE account_id = $1`),
    nextNumber: counters[0]?.next_number ?? null,
    bytesUsed: counters[0]?.bytes_used ?? null,
    events: await n(`SELECT count(*) AS n FROM domain_events WHERE account_id = $1`),
    runEvents: await n(`SELECT count(*) AS n FROM run_events WHERE account_id = $1`),
  };
}

/**
 * Deterministic race: holds the account's `discussion_counters` row lock on
 * a separate superuser connection, runs `start` (which launches concurrent
 * calls that each read before they reach that lock), waits until `waiters`
 * backends are blocked on a lock, then releases. Every call has therefore
 * passed its read-before-write check before any of them can write, so only
 * the unique index can decide the winner.
 */
export async function raceOnCountersLock<T>(
  adminPool: import("pg").Pool,
  accountId: string,
  waiters: number,
  start: () => Promise<T>[],
): Promise<T[]> {
  const holder = await adminPool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query(`SELECT 1 FROM discussion_counters WHERE account_id = $1 FOR UPDATE`, [accountId]);
    const calls = start();
    const deadline = Date.now() + 10_000;
    for (;;) {
      await holder.query("SELECT pg_stat_clear_snapshot()"); // pg_stat_activity is cached per transaction
      const { rows } = await holder.query<{ n: string }>(
        // Waiters queue behind each other for a row lock, so they are not
        // all blocked by the holder itself; count them by what they wait on.
        `SELECT count(*) AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query LIKE '%FROM discussion_counters WHERE account_id = $1 FOR UPDATE%'`,
      );
      if (Number(rows[0]!.n) >= waiters) break;
      if (Date.now() > deadline) throw new Error("race: callers never reached the counters lock");
      await new Promise((r) => setTimeout(r, 10));
    }
    await holder.query("COMMIT");
    return await Promise.all(calls);
  } finally {
    await holder.query("ROLLBACK").catch(() => undefined);
    holder.release();
  }
}
