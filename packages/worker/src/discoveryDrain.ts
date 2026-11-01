import type { Pool } from "pg";
import { runQueuedDiscoveries, type DiscoveryOutcome, type DiscoveryRunDeps } from "@fx/core/src/discovery/run.js";
import { reportError } from "@fx/telemetry";

/**
 * D#483 S4-c2: the drain of the install and payment discovery queue, a pass in the claim verifier's 15-minute tick (no cron of its own).
 *
 * S4-c queues one `discovery_runs` row per repository and trigger; until this pass nothing ran them. One pass, under one advisory lock (a second pass
 * that finds it held does nothing, so no run is taken twice):
 *  1. `discovery_drain_list` (0949) names the accounts with a queued run or with a removed repository whose proposals are still `new`. Ids only.
 *  2. For each account, under its own tenant, `runQueuedDiscoveries` runs the queued rows oldest first (each reads GitHub through the read-only plan source and
 *     writes proposals as the import's own role, never a work item or an agent run) and then withdraws the `new` proposals of repositories with no installation.
 * A pass stops taking accounts, and stops between the runs of the account it is on, after DRAIN_PASS_BUDGET_MS; the accounts and runs left stay queued and keep the next tick
 * coming (`more`), as does a full page from the lister. One account that fails never holds up the rest.
 */

export const DRAIN_PASS_BUDGET_MS = 20_000;
/** The rows `discovery_drain_list` returns at most (0949); a full page means more accounts may be waiting. */
export const DRAIN_LIST_LIMIT = 100;
const DRAIN_LOCK = "fx:discovery_drain";

export interface DiscoveryDrainDeps {
  /** The runner login's pool (it holds EXECUTE on the list and, as a member of app_user, the importer's SET ROLE). */
  pool: Pool;
  openSource: DiscoveryRunDeps["openSource"];
  /** The finished preview's classified issues for one repository of one account (S4c-3). */
  previewHints?: (accountId: string) => DiscoveryRunDeps["previewHints"];
  now?: () => number;
}

export interface DiscoveryDrainCounts {
  /** Why the pass did nothing: another pass holds the lock (`busy`), or no source is wired (`not_configured`). */
  idle?: string;
  accounts: number;
  succeeded: number;
  skipped: number;
  failed: number;
  /** Accounts whose pass threw (listed again next tick). */
  errors: number;
  /** True when the time budget left accounts for the next tick. */
  more: boolean;
}

export const emptyDrainCounts = (idle?: string): DiscoveryDrainCounts => ({ ...(idle ? { idle } : {}), accounts: 0, succeeded: 0, skipped: 0, failed: 0, errors: 0, more: false });

export function createDiscoveryDrain(deps: DiscoveryDrainDeps): () => Promise<DiscoveryDrainCounts> {
  const now = deps.now ?? Date.now;
  return async function sweepDiscoveryQueue(): Promise<DiscoveryDrainCounts> {
    const counts = emptyDrainCounts();
    // One pass at a time: a transaction-scoped try-lock on its own connection, held for the whole pass (the pool needs one more free connection).
    const lock = await deps.pool.connect();
    try {
      await lock.query("BEGIN");
      const got = await lock.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok", [DRAIN_LOCK]);
      if (got.rows[0]?.ok !== true) return emptyDrainCounts("busy");
      const { rows } = await deps.pool.query<{ account_id: string }>("SELECT account_id FROM discovery_drain_list()");
      const startedAt = now();
      if (rows.length >= DRAIN_LIST_LIMIT) counts.more = true;
      const overBudget = (): boolean => now() - startedAt > DRAIN_PASS_BUDGET_MS;
      for (const r of rows) {
        if (overBudget()) {
          counts.more = true;
          break;
        }
        counts.accounts += 1;
        try {
          const hints = deps.previewHints?.(r.account_id);
          const outcomes: DiscoveryOutcome[] = await runQueuedDiscoveries({ pool: deps.pool, accountId: r.account_id, openSource: deps.openSource, stop: () => overBudget() && (counts.more = true), ...(hints ? { previewHints: hints } : {}) });
          for (const o of outcomes) if (o.state === "succeeded" || o.state === "skipped" || o.state === "failed") counts[o.state] += 1;
        } catch (err) {
          reportError(err, { stage: "discovery_drain.account" });
          counts.errors += 1;
        }
      }
      return counts;
    } finally {
      await lock.query("COMMIT").catch((err: unknown) => reportError(err, { stage: "discovery_drain.unlock" }));
      lock.release();
    }
  };
}
