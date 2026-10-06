import type { Pool, PoolClient } from 'pg';
import { withTenant } from './pg.js';
import type { Budget } from './types.js';
import type { ComputeBasis } from './sandboxUsage.js';

export type LedgerSource = 'customer_gateway' | 'customer_anthropic' | 'sandbox' | 'workflow' | 'operator_subscription';

export interface SettleEntry {
  budget: Budget;
  actualUsd: number;
  source: LedgerSource;
  /** A compute row's basis (how the figure was arrived at); never set on a model row. */
  computeBasis?: ComputeBasis;
}

export interface SettleParams {
  accountId: string;
  runId: string;
  /** One entry per budget this run reserved against and is now settling.
   * A run that reserved both 'model' and a compute budget settles both in
   * one call, or in two separate calls -- either is safe, since each
   * entry only touches its own budget's reservation row. */
  entries: SettleEntry[];
}

export interface SettleResult {
  ledgerRows: { budget: Budget; usd: number }[];
}

/**
 * D#2605 H05 pass/fail 6: "settle(run) writes ledger rows and releases
 * the unused reservation. Settled + open never exceeds the cap."
 *
 * "Releases the unused reservation" is implicit rather than a separate
 * write: once a reservation's state moves to 'settled' (see
 * migrations/0002_spend_fns.sql's transition trigger), it stops counting
 * toward the 'open' aggregate that reserve()'s cap checks sum over --
 * only the actual ledger.usd this call writes counts from then on. There
 * is deliberately no code path that could write a ledger row for less
 * than the reservation and leave the rest still marked 'open'.
 */
/**
 * D#2 H09b2 fix round 1 (S-MUST 2): the same-client counterpart to
 * `reserve.ts`'s `reserveWith` -- lets a caller already holding an open
 * transaction (typically also this account+budget's advisory lock) settle
 * within it, so the ledger write commits before the lock releases and the
 * next racer's own read already sees it. `settle` below is a thin
 * `withTenant` wrapper around this, matching `reserve`/`reserveWith`.
 */
export async function settleWith(client: PoolClient, params: SettleParams): Promise<SettleResult> {
  const ledgerRows: { budget: Budget; usd: number }[] = [];
  for (const entry of params.entries) {
    const kind = entry.budget === 'model' ? 'model' : 'compute';
    await client.query(
      `INSERT INTO ledger (account_id, kind, source, usd, run_id, budget, compute_basis)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [params.accountId, kind, entry.source, entry.actualUsd, params.runId, entry.budget, entry.computeBasis ?? null],
    );
    await client.query(
      `UPDATE spend_reservations SET state = 'settled'
       WHERE account_id = $1 AND run_id = $2 AND budget = $3 AND state = 'open'`,
      [params.accountId, params.runId, entry.budget],
    );
    ledgerRows.push({ budget: entry.budget, usd: entry.actualUsd });
  }
  return { ledgerRows };
}

export async function settle(pool: Pool, params: SettleParams): Promise<SettleResult> {
  return withTenant(pool, params.accountId, (client) => settleWith(client, params));
}

export interface ReleaseParams {
  accountId: string;
  runId: string;
  budget: Budget;
}

/**
 * D#2 H09b2 fix round 2 (double-settle race, CWE-362/840): the same-client
 * counterpart to `settleWith` above -- lets a caller already holding an
 * open transaction (typically also this account+budget's advisory lock)
 * release within it, so the state flip commits before the lock releases
 * and the next racer's own read already sees it. `release` below is a
 * thin `withTenant` wrapper around this, matching `settle`/`settleWith`.
 */
export async function releaseWith(client: PoolClient, params: ReleaseParams): Promise<void> {
  await client.query(
    `UPDATE spend_reservations SET state = 'released'
     WHERE account_id = $1 AND run_id = $2 AND budget = $3 AND state = 'open'`,
    [params.accountId, params.runId, params.budget],
  );
}

/** Cancels an open reservation with no ledger entry at all -- for a run
 * that never produced billable usage (e.g. refused before it started).
 * Distinct from settle(), which always records the actual cost (even a
 * $0 one) in the ledger. */
export async function release(pool: Pool, params: ReleaseParams): Promise<void> {
  await withTenant(pool, params.accountId, (client) => releaseWith(client, params));
}
