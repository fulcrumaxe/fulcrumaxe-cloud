import type { Pool } from 'pg';
import { announceNewRunAction } from '../runActions/request.js';
import type { RunActionSignal } from '../runActions/signal.js';
import { markWorkPending } from '../pendingWork.js';
import { withTenant } from '../tenancy/withTenant.js';
import { runSetupRequestCheck, type VercelEnvSource } from './checks.js';
import { markSetupRequestDoneInTx, reopenSetupRequest, stampMarkDoneCheck, type SetupRequest } from './store.js';

/**
 * D#598 P8b-2: Mark done with its own immediate check. The check sweep lists open requests only, so a request a person has just closed is
 * never looked at by it; this is the only place the check runs for it.
 *
 *   1. One transaction closes the request as `marked_done` and files ONE `advance_work_item` restart for its work item (store.ts, keyed per
 *      request and open generation). The item can go on at once; the person's word is what resumes it. A second press files nothing.
 *   2. For a request with an automatic check, and only while a credential source is bound, the check runs with no database connection held.
 *      While it runs the request reads "Checking now." (derived from the row, copy.ts).
 *   3. The answer is written under the same tenant as the person who pressed:
 *        - pass                                    the stamp moves past the closing; nothing else.
 *        - the provider could not be asked          the person's word stands (the same words as a kind with no check: "press Mark done when it's
 *                                                   finished" must really resume), the stamp moves, nothing else.
 *        - not yet (missing / wrong environment)   the request goes back to open with the check's reason ({@link reopenSetupRequest}: the one
 *                                                   transition the table allows from `done`, folding into a newer open request for the same step).
 *                                                   It reads sentence 4 and holds its item again: a workflow that the restart already started is
 *                                                   stopped by the hold at its next step, and one that has not started is refused.
 *      A failure writing the answer is logged by a fixed code and the person's word stands; the request is done, never half-changed.
 */

export interface MarkDoneDeps {
  /** The app_user pool: every write is under the pressing person's tenant. */
  pool: Pool;
  envSource: VercelEnvSource;
  /** The run-action kick for the restart. Absent in a deployment with no worker: the row is the durable signal and the sweep finds it. */
  signal?: RunActionSignal | null;
  log?: (line: string) => void;
}

/** What the immediate check did. `none`: the request has no check, or no source is bound; nothing was asked. */
export type MarkDoneCheck = 'none' | 'passed' | 'unreachable' | 'not_yet' | 'failed';

export interface MarkDoneResult {
  /** The request that was pressed, as it reads now (open again after a failed check, done otherwise). */
  request: SetupRequest;
  /** False for a repeat: nothing was filed and nothing was checked. */
  changed: boolean;
  restart: { actionId: string; replayed: boolean } | null;
  check: MarkDoneCheck;
  /** The newer open request that took a failed check's reason instead, when the same step had been asked again. */
  foldedInto: SetupRequest | null;
}

export async function markSetupRequestDone(deps: MarkDoneDeps, input: { accountId: string; userId: string; id: string }): Promise<MarkDoneResult> {
  const log = deps.log ?? ((line: string) => console.info(line));
  const marked = await withTenant(deps.pool, input.accountId, input.userId, undefined, (client) => markSetupRequestDoneInTx(client, { id: input.id, userId: input.userId }));
  if (!marked.changed) return { request: marked.request, changed: false, restart: null, check: 'none', foldedInto: null };
  if (marked.restart !== null && !marked.restart.replayed) {
    if (deps.signal) await announceNewRunAction({ signal: deps.signal }, { actionId: marked.restart.actionId, accountId: input.accountId, kind: 'advance_work_item' });
    else void markWorkPending('run-action-sweep');
  }
  const done = (over: Partial<MarkDoneResult>): MarkDoneResult => ({ request: marked.request, changed: true, restart: marked.restart, check: 'none', foldedInto: null, ...over });
  if (marked.request.checkKind === null || !deps.envSource.available) return done({});

  const outcome = await runSetupRequestCheck(deps.envSource, input.accountId, marked.request);
  if (outcome === null) return done({});
  try {
    if (outcome.pass || outcome.reason === 'check_unavailable') {
      const request = await withTenant(deps.pool, input.accountId, input.userId, undefined, (client) => stampMarkDoneCheck(client, { id: marked.request.id }));
      return done({ request, check: outcome.pass ? 'passed' : 'unreachable' });
    }
    const reason = outcome.reason;
    const back = await withTenant(deps.pool, input.accountId, input.userId, undefined, (client) => reopenSetupRequest(client, { id: marked.request.id, reason }));
    return back.folded
      ? done({ check: 'not_yet', foldedInto: back.request })
      : done({ request: back.request, check: 'not_yet' });
  } catch (error) {
    // fx-swallow-ok: the person's Mark done is already committed with its restart; the failed write is logged by request id and a fixed code, never the driver's message
    log(JSON.stringify({ event: 'setup_request_mark_done.check_write_failed', setup_request_id: marked.request.id, code: (error as { code?: string } | null)?.code ?? 'error' }));
    return done({ check: 'failed' });
  }
}
