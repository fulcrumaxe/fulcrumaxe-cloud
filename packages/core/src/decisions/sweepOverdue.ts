import type { Pool } from 'pg';
import { CATALOGUE } from '@fx/decisions';
import { ASK_DUE_DEFAULT_LIMIT, catalogueClassOf, listDueAsks, timeOutAskIn, type AskOption } from '@fx/db/src/decisionAsks.js';
import { getCurrentDialSetting } from '@fx/db/src/decisions.js';
import { DIAL_VERSION_CATALOGUE_DEFAULT, writeReceipt } from '@fx/db/src/receiptWriter.js';
import { emitDomainEvent } from '../domain-events/emit.js';
import { withTenant } from '../tenancy/withTenant.js';

/**
 * D#7 DP12a-2 (DP-C5 section 4, DP-C9 section 6): what happens when an ask's answer window ends. Nothing is denied
 * by silence (R1): the sweep never writes `answered` and never produces `decision_denied`. An open ask past its
 * `answer_due_at` goes one of two ways, by the `timeout_outcome` frozen on it at raise time:
 *
 *   - `stop_and_flag`: open -> overdue, and one `decision.ask_overdue` event (ids and fixed codes only). It stays
 *     answerable.
 *   - `proceed_recommended`: open -> proceeded on its proposed option, with a receipt (actor 'policy', read from
 *     the session by the database: no user is set here) written on the same transaction. The resume that follows is
 *     DP11c's reconcile, which reads `proceeded` asks: this file writes no run-action request. The outcome
 *     `proceeded_without_answer` is the ask's own state (`proceeded`, no `answered_by`) plus the policy receipt it links.
 *
 * It proceeds only when every one of these holds, and otherwise treats the ask as `stop_and_flag` (a fail-safe, not a
 * denial): the catalogue entry's `timeoutOutcomes` includes `proceed_recommended`, the ask has a run (DP-C9 2c: a receipt
 * needs one), and the proposed option is one of the ask's options.
 *
 * One transaction per ask, on the RECEIPT pool under that ask's own tenant, with no user and no token. The claim is
 * `decision_ask_time_out` (migration 0853): `FOR UPDATE SKIP LOCKED` plus the same compare-and-set on `state = 'open'`
 * that the answer and the withdrawal use, so an ask has exactly one winner. When the database moves nothing (an answer or
 * a withdrawal got there first) the transaction is rolled back, receipt and event with it. Re-running is a no-op because
 * the list reads `open` asks only. It has no scheduler: the worker's one-minute tick calls it.
 */

/** The one time source. Injectable so the window ends on a fake clock in tests. */
export interface SweepClock {
  now(): Date;
}

export const SWEEP_REAL_CLOCK: SweepClock = { now: () => new Date() };

/** The outcome word DP-C5 names for a policy receipt. It is the ask's `proceeded` state plus the policy receipt; the receipt has no column for it. */
export const ASK_PROCEEDED_OUTCOME = 'proceeded_without_answer';

export interface OverdueSweepResult {
  /** Moved to `overdue` (stop_and_flag, or a proceed that failed a safety condition above). */
  overdue: number;
  /** Moved to `proceeded`, with a policy receipt. */
  proceeded: number;
  /** Listed, but another writer got there first (an answer, a withdrawal, another sweeper). Nothing was written. */
  skipped: number;
  /** Asks whose transaction failed; they stay open and the next tick looks again. */
  failed: number;
  /** The asks moved to `proceeded` in this call, for the caller's log line. Ids only. */
  proceededAskIds: string[];
}

interface DueRow {
  id: string;
  repo_id: string | null;
  work_item_id: string;
  run_id: string | null;
  decision_type: string;
  options: AskOption[];
  proposed: string;
  timeout_outcome: 'stop_and_flag' | 'proceed_recommended';
}

/** Thrown inside the per-ask transaction to roll it back when the database moved nothing. */
class NothingMoved extends Error {}

type Moved = 'overdue' | 'proceeded' | 'skipped';

async function timeOutOne(pool: Pool, accountId: string, askId: string, now: Date): Promise<Moved> {
  try {
    return await withTenant(pool, accountId, async (client): Promise<Moved> => {
      const found = await client.query<DueRow>(
        `SELECT id, repo_id, work_item_id, run_id, decision_type, options, proposed, timeout_outcome
           FROM decision_asks WHERE id = $1::uuid AND account_id = $2::uuid AND state = 'open' AND answer_due_at <= $3::timestamptz`,
        [askId, accountId, now],
      );
      const ask = found.rows[0];
      if (ask === undefined) return 'skipped';
      const entry = CATALOGUE.find((e) => e.id === ask.decision_type);
      const cls = catalogueClassOf(ask.decision_type);
      const canProceed = ask.timeout_outcome === 'proceed_recommended'
        && entry !== undefined && cls !== null && entry.timeoutOutcomes.includes('proceed_recommended')
        && ask.run_id !== null
        && ask.options.some((o) => o.id === ask.proposed);

      if (canProceed) {
        // DP-C9 2b: the dial version in force now, or 0 (the catalogue default) with no row or no repo.
        const dial = ask.repo_id === null ? null : await getCurrentDialSetting(client, ask.repo_id, ask.decision_type);
        const receipt = await writeReceipt(client, {
          class: cls,
          runId: ask.run_id!,
          workItemId: ask.work_item_id,
          decisionType: ask.decision_type,
          chosen: ask.proposed,
          // The recommendation was taken, so the alternative that was not is 'deny' (DP-C9 2a).
          rejectedAlternative: 'deny',
          dialVersion: dial?.version ?? DIAL_VERSION_CATALOGUE_DEFAULT,
          // The customer's own setting decided, reading nothing from the agent's inputs; those stay on the ask (input_trust_classes).
          quotedInputs: [{ trust: 'trusted', storedBody: ask.proposed }],
        });
        if (receipt.store !== 'decision_receipts') throw new NothingMoved();
        if (!await timeOutAskIn(client, { askId: ask.id, now, to: 'proceeded', receiptId: receipt.id })) throw new NothingMoved();
        return 'proceeded';
      }

      if (!await timeOutAskIn(client, { askId: ask.id, now, to: 'overdue' })) throw new NothingMoved();
      // On this transaction, so the event exists only if the move commits. Ids and fixed codes only.
      await emitDomainEvent(client, {
        type: 'decision.ask_overdue',
        accountId,
        subjectId: ask.id,
        payload: { ask_id: ask.id, work_item_id: ask.work_item_id, run_id: ask.run_id, decision_type: ask.decision_type, timeout_outcome: ask.timeout_outcome },
      });
      return 'overdue';
    });
  } catch (err) {
    if (err instanceof NothingMoved) return 'skipped';
    throw err;
  }
}

/**
 * Ends the answer window of up to `limit` open asks that are due at `clock.now()`, across tenants. Never throws: a
 * failed list or a failed ask is counted and the next tick looks again (the caller logs a fixed line).
 */
export async function sweepOverdueAsks(pool: Pool, clock: SweepClock, limit: number = ASK_DUE_DEFAULT_LIMIT): Promise<OverdueSweepResult> {
  const out: OverdueSweepResult = { overdue: 0, proceeded: 0, skipped: 0, failed: 0, proceededAskIds: [] };
  const now = clock.now();
  let due;
  try {
    due = await listDueAsks(pool, now, limit);
  } catch {
    // fx-swallow-ok: counted as failed; the worker logs a fixed line and the next tick lists again
    out.failed++;
    return out;
  }
  for (const d of due) {
    try {
      const moved = await timeOutOne(pool, d.accountId, d.askId, now);
      if (moved === 'skipped') out.skipped++;
      else if (moved === 'overdue') out.overdue++;
      else {
        out.proceeded++;
        out.proceededAskIds.push(d.askId);
      }
    } catch {
      // fx-swallow-ok: counted as failed and the ask stays open; never the error's text, which can carry a host or a user
      out.failed++;
    }
  }
  return out;
}
