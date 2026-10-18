import type { Pool } from 'pg';
import { listDueSetupRequests, SETUP_REQUEST_DUE_AFTER_SECONDS, SETUP_REQUEST_LIST_DUE_LIMIT } from '@fx/db/src/setupRequestLister.js';
import { withTenant } from '../tenancy/withTenant.js';
import { NotFoundError } from '../tenancy/errors.js';
import { markWorkPending } from '../pendingWork.js';
import { runSetupRequestCheck, type VercelEnvSource } from './checks.js';
import { applyCheckOutcome, getSetupRequest, type SetupRequest } from './store.js';

/**
 * D#598 P8b: one pass of the setup-request check sweep, the cron's body. It lists the requests that are due (the cross-account definer of
 * migration 0874, on the run-writer pool, no tenant set), then takes them ONE AT A TIME:
 *   1. under the request's own tenant, read it (a short transaction, closed before anything leaves the platform);
 *   2. ask the provider, with no database connection held;
 *   3. under the same tenant, write what the check found (store.ts `applyCheckOutcome`): a pass closes the request as `check_passed` and files
 *      one `advance_work_item`; "not yet" only moves the check stamp.
 * The session user of the tenant transaction is the person who proposed the request (the table's update policy and the run-action definer
 * both need a member of the account; the proposer was an owner or admin when they asked). The list only returns requests whose proposer still is one;
 * if they stop being one between the list and the write, the write is refused by the database, the request stays open and is logged
 * `writer_gone`, and it drops out of the list from the next pass (Mark done by a current owner or admin is the way on).
 *
 * The pass runs only on a tick the pending-work marker lets through (apps/web handler). `nextDueAt` asks for the next tick
 * 45 seconds after the pass started whenever this pass found anything (and a source is bound), so the request just checked is looked at again
 * on the next minute's tick, and so is one that was not yet due when this pass listed; the first pass that finds nothing returns null and the marker is cleared.
 */

/** A pass stops starting new checks after this long, leaving the rest to the next tick (the route has a 60 second limit). */
export const CHECK_PASS_BUDGET_MS = 40_000;

export interface CheckSweepDeps {
  /** The run-writer pool (the runner login): it holds EXECUTE on the lister and, as `app_user`, the tenant access the rest needs. */
  pool: Pool;
  envSource: VercelEnvSource;
  now?: () => number;
  log?: (line: string) => void;
  /** Called after a pass committed a restart request, so the run-action sweep is not skipped by its own gate. */
  announceRunAction?: (actionId: string, accountId: string) => void;
}

export interface CheckSweepCounts {
  listed: number;
  /** Closed as `check_passed`. */
  passed: number;
  /** Still open; the check's stamp moved. */
  notYet: number;
  /** Not written: withdrawn, marked done or answered by another pass since it was listed. */
  skipped: number;
  /** A request that could not be read or written (logged by id and a fixed code). */
  failed: number;
  /** Epoch ms of the next tick this pass asks for, or null when it found nothing. */
  nextDueAt: number | null;
}

export async function sweepSetupRequestChecks(deps: CheckSweepDeps): Promise<CheckSweepCounts> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.info(line));
  const counts: CheckSweepCounts = { listed: 0, passed: 0, notYet: 0, skipped: 0, failed: 0, nextDueAt: null };
  const startedAt = now();
  // The next tick is asked for from when this pass STARTED, by the same 45 second rule the list uses, not a full interval from when its list
  // query returned: the cron fires a minute after this one fired, which is earlier than (query end + 60 s), so a marker set that way
  // would make the next minute's tick skip and the real interval 120 s. The list's own rule keeps a too-early tick from re-checking.
  // With no provider bound a check cannot pass, so nothing is asked for: the platform may go idle (whoever binds a source marks it pending).
  const nextTick = deps.envSource.available ? startedAt + SETUP_REQUEST_DUE_AFTER_SECONDS * 1000 : null;
  let due;
  try {
    due = await listDueSetupRequests(deps.pool, { limit: SETUP_REQUEST_LIST_DUE_LIMIT, minAgeSeconds: SETUP_REQUEST_DUE_AFTER_SECONDS });
  } catch (error) {
    // fx-swallow-ok: counted as failed and logged with a fixed code (never the driver's message, which can carry a host); the next tick looks again
    counts.failed += 1;
    log(JSON.stringify({ event: 'setup_request_check.list_failed', code: (error as { code?: string } | null)?.code ?? 'error' }));
    // The list could not be read: ask for another tick rather than letting the marker go.
    counts.nextDueAt = nextTick;
    return counts;
  }
  counts.listed = due.length;
  if (due.length > 0) counts.nextDueAt = nextTick;
  for (const item of due) {
    if (now() - startedAt > CHECK_PASS_BUDGET_MS) break;
    try {
      // 1. The request and the person to write as, under its own tenant.
      const read = await withTenant(deps.pool, item.accountId, async (client) => {
        let request: SetupRequest;
        try {
          request = await getSetupRequest(client, item.setupRequestId);
        } catch (error) {
          if (error instanceof NotFoundError) return null;
          throw error;
        }
        return request;
      });
      if (read === null || read.state !== 'open' || read.createdBy === null) {
        counts.skipped += 1;
        continue;
      }
      // 2. The provider, with no connection held.
      const outcome = await runSetupRequestCheck(deps.envSource, item.accountId, read);
      if (outcome === null) {
        counts.skipped += 1;
        continue;
      }
      // 3. The result, under the same tenant, as the person who proposed the request.
      const applied = await withTenant(deps.pool, item.accountId, read.createdBy, undefined, (client) => applyCheckOutcome(client, { id: read.id, outcome }));
      if (applied.result === 'skipped') counts.skipped += 1;
      else if (applied.result === 'stamped') counts.notYet += 1;
      else {
        counts.passed += 1;
        if (applied.advance !== null && !applied.advance.replayed) (deps.announceRunAction ?? announceRunActionPending)(applied.advance.actionId, item.accountId);
      }
    } catch (error) {
      // fx-swallow-ok: one request's failure is counted and logged by id and a fixed code; the pass goes on to the next request and the request is listed again
      counts.failed += 1;
      const code = (error as { code?: string } | null)?.code;
      log(JSON.stringify({ event: 'setup_request_check.failed', setup_request_id: item.setupRequestId, code: code === '42501' ? 'writer_gone' : (code ?? 'error') }));
    }
  }
  return counts;
}

/** The default announcement: the run-action sweep has a restart request to pick up (the row is the durable signal; this only wakes the gated cron). */
export function announceRunActionPending(): void {
  void markWorkPending('run-action-sweep');
}
