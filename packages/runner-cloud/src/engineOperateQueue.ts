import type { Pool } from "pg";
import { issueSystemStarts, type SystemStartDeps, type SystemStartResult } from "./engineSystemStarts.js";
import { issueSystemStops, type SystemStopResult } from "./engineSystemStops.js";

/**
 * D#845 ON-13c2 (Ruling 98): the operate queue's drain. Turning operate on or off, or ticking or unticking a repo, leaves one row per repo in `engine_operate_queue` (migration 1105) and starts or stops nothing in the request that changed it.
 * This pass, run on the reconcile tick, claims the rows (the definer holds the account's claimed rows to 4 at once), and for each one calls the issuer the row names, never a person's: a `stop` row calls `issueSystemStops` for that repo, a `start`
 * row calls `issueSystemStarts` with the cause `operate_on`, whose issuer consumes the row in the same transaction it signs the start. Both issuers re-derive their gates from the rows, so a row is a prompt to look at one repo, not a decision.
 *
 * Every claimed row is finished before the pass ends: `done` when the issuer dealt with it (or found nothing left to do), `retry` when a gate said not yet (plan, a start or stop waiting, GitHub, an error), `release` when the pass could not try
 * (no signer, no time left). A pass that dies leaves its rows `running`, and the claim puts them back after ten minutes.
 */

/** The start issuer's deps: the stop issuer takes a subset of them. */
export type OperateQueueDeps = SystemStartDeps;

export interface OperateQueueScope {
  accountId?: string;
  /** Needs `accountId`. */
  repoId?: string;
  /** Rows to claim, 1 to 500. Defaults to 50. */
  limit?: number;
  msLeft?: () => number;
}

export type OperateQueueOutcome = "done" | "retry" | "release";
export type OperateQueueAction = "start" | "stop";

export interface OperateQueuePass {
  not_configured: boolean;
  /** Starts and stops signed by this pass. */
  issued: number;
  results: Array<{ account_id: string; repo_id: string; action: OperateQueueAction; result: SystemStartResult | SystemStopResult | "error" | "released"; outcome: OperateQueueOutcome }>;
}

interface ClaimedRow { o_account: string; o_repo: string; o_epoch: number; o_action: OperateQueueAction; o_attempts: number }

const DEFAULT_LIMIT = 50;

/** A start with no answer for its repo had nothing left to start (not placed, not operated, no finished install): the row is spent. A gate that said not yet keeps it. */
export function startOutcome(result: SystemStartResult | undefined): OperateQueueOutcome {
  switch (result) {
    case undefined:
    case "issued":
    case "cause_gone":
    case "not_placed":
    case "epoch_moved":
      return "done";
    default:
      return "retry";
  }
}

export function stopOutcome(result: SystemStopResult | "error" | undefined): OperateQueueOutcome {
  switch (result) {
    case undefined:
    case "issued":
    case "superseded_only":
    case "cause_gone":
    case "already_stopping":
    case "not_placed":
    case "epoch_moved":
      return "done";
    default:
      return "retry";
  }
}

const claim = async (pool: Pool, accountId: string | null, repoId: string | null, limit: number): Promise<ClaimedRow[]> =>
  (await pool.query<ClaimedRow>("SELECT * FROM engine_operate_queue_claim($1::uuid, $2::uuid, $3::integer)", [accountId, repoId, limit])).rows;

const finish = async (pool: Pool, row: ClaimedRow, outcome: OperateQueueOutcome): Promise<void> => {
  await pool.query("SELECT engine_operate_queue_finish($1::uuid, $2::uuid, $3::integer, $4, $5)", [row.o_account, row.o_repo, row.o_epoch, row.o_action, outcome]);
};

/** One pass over the queue (see the header). With no signer every claimed row is released and the pass says `not_configured`. */
export async function drainOperateQueue(deps: OperateQueueDeps, scope: OperateQueueScope = {}): Promise<OperateQueuePass> {
  if (scope.repoId !== undefined && scope.accountId === undefined) throw new Error("drainOperateQueue: a repo needs its account");
  const pass: OperateQueuePass = { not_configured: false, issued: 0, results: [] };
  const rows = await claim(deps.pool, scope.accountId ?? null, scope.repoId ?? null, scope.limit ?? DEFAULT_LIMIT);
  const route = "reconcile.engine_operate_queue";
  const done = (row: ClaimedRow, result: OperateQueuePass["results"][number]["result"], outcome: OperateQueueOutcome): void =>
    void pass.results.push({ account_id: row.o_account, repo_id: row.o_repo, action: row.o_action, result, outcome });
  const settle = async (row: ClaimedRow, outcome: OperateQueueOutcome, result: OperateQueuePass["results"][number]["result"]): Promise<void> => {
    try {
      await finish(deps.pool, row, outcome);
      done(row, result, outcome);
    } catch (error) {
      // The row stays `running` and the claim gives it back after ten minutes; the pass goes on.
      deps.reportError(error, { stage: "engine_operate_queue.finish", route, code: "engine_operate_queue_finish_failed" });
      done(row, "error", "retry");
    }
  };
  for (const row of rows) {
    if (pass.not_configured || (scope.msLeft !== undefined && scope.msLeft() <= 0)) {
      await settle(row, "release", "released");
      continue;
    }
    try {
      const sub = { accountId: row.o_account, repoId: row.o_repo, ...(scope.msLeft === undefined ? {} : { msLeft: scope.msLeft }) };
      if (row.o_action === "stop") {
        const stops = await issueSystemStops(deps, sub);
        if (stops.not_configured) {
          pass.not_configured = true;
          await settle(row, "release", "released");
          continue;
        }
        pass.issued += stops.issued;
        const result = stops.results.find((r) => r.repo_id === row.o_repo)?.result;
        await settle(row, stopOutcome(result), result ?? "cause_gone");
      } else {
        const starts = await issueSystemStarts(deps, { ...sub, cause: "operate_on" });
        if (starts.not_configured) {
          pass.not_configured = true;
          await settle(row, "release", "released");
          continue;
        }
        pass.issued += starts.issued;
        const result = starts.results.find((r) => r.repo_id === row.o_repo)?.result;
        await settle(row, startOutcome(result), result ?? "cause_gone");
      }
    } catch (error) {
      deps.reportError(error, { stage: "engine_operate_queue.drain", route, code: "engine_operate_queue_failed" });
      await settle(row, "retry", "error");
    }
  }
  return pass;
}
