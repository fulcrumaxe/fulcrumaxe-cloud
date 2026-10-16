import type { Pool } from "pg";
import { ASK_WITHDRAW_DEFAULT_LIMIT, ASK_WITHDRAW_REASONS, withdrawStaleAsks, type AskWithdrawReason } from "@fx/db/src/decisionAsks.js";

/**
 * D#7 DP4b-1 (R-7-DP4b-3): the ask-withdrawal sweep. A parked item's open question is withdrawn, once and for good, when its item is closed or merged
 * (`item_closed`), halted (`item_halted`), or has a newer executor run because a person pressed Approve or Build again (`superseded`). The work is
 * one database function (migration 0826, `decision_ask_withdraw`) on the RECEIPT pool: this file only calls it in batches and counts.
 *
 * Cross-tenant by design, like the invariant sweep: nothing in the call names a tenant and nothing in the result is user text. It never throws: a failed
 * batch is counted and logged as a fixed line (never the error's text, which can carry a host or a user), and the next tick looks again. Withdrawn is
 * terminal, so a reopened item does not bring a stale question back, and an answer racing the sweep goes through the same compare-and-set, so exactly
 * one of the two wins.
 */

/** The most batches one tick runs, so a large backlog cannot hold the tick: the rest goes next time. */
export const ASK_WITHDRAW_MAX_BATCHES = 5;

export interface AskWithdrawSweepResult {
  withdrawn: number;
  byReason: Record<AskWithdrawReason, number>;
  /** True when a batch failed; the batches before it still count. */
  failed: boolean;
}

export interface AskWithdrawSweepDeps {
  /** The RECEIPT pool: the only login that can call the definer. */
  pool: Pick<Pool, "query">;
  warn: (line: string) => void;
  limit?: number;
  maxBatches?: number;
}

export async function sweepAskWithdrawals(deps: AskWithdrawSweepDeps): Promise<AskWithdrawSweepResult> {
  const limit = deps.limit ?? ASK_WITHDRAW_DEFAULT_LIMIT;
  const out: AskWithdrawSweepResult = { withdrawn: 0, byReason: Object.fromEntries(ASK_WITHDRAW_REASONS.map((r) => [r, 0])) as Record<AskWithdrawReason, number>, failed: false };
  for (let batch = 0; batch < (deps.maxBatches ?? ASK_WITHDRAW_MAX_BATCHES); batch++) {
    let moved;
    try {
      moved = await withdrawStaleAsks(deps.pool, limit);
    } catch {
      // fx-swallow-ok: counted as failed and logged as a fixed line (never the error's text); the next tick looks again
      out.failed = true;
      deps.warn(JSON.stringify({ event: "decision.ask_withdraw_failed" }));
      break;
    }
    for (const m of moved) {
      out.withdrawn++;
      out.byReason[m.reason]++;
    }
    if (moved.length < limit) break;
  }
  if (out.withdrawn > 0) deps.warn(JSON.stringify({ event: "decision.ask_withdrawn", ...out.byReason, total: out.withdrawn }));
  return out;
}
