import type { Pool } from 'pg';
import { readLapState, type LapTime, type WorkOptions } from './runner.js';

/**
 * A fast path for a stuck reconcile job (D#6 STALL-ALERT-FAST). The once-a-day errors digest is too slow to notice a job that has work waiting
 * and has not completed a pass; this runs at the end of a reconcile tick that already holds a connection, so it adds no wake-up of its own.
 *
 * A job is stalled when it has work now (see jobsWithWork) and its lap is past twice its effective cadence (readLapTimes' `breach`). A job with
 * nothing to do is never stalled, however old its last pass: an idle deployment legitimately goes hours between passes.
 *
 * One ongoing stall is one notice. The state is a single column on the job's row (`stall_alerted_at`, null while no notice is outstanding), so it
 * survives a restart and a cache eviction:
 *   - stalled, nothing outstanding        -> 'stalled' notice, then the column is set;
 *   - stalled, outstanding for 6 hours    -> 'still_stalled' notice, column moved to now;
 *   - not stalled, something outstanding  -> 'recovered' notice, column cleared.
 * A notice the sink fails to deliver leaves the column as it was, so the next tick tries again; the failure goes to `onSinkError` (stdout) and is
 * never thrown. Notices name the job, the time since its last pass and what is waiting, from fixed text: no tenant data and nothing read from a row.
 */

export const STALL_REPEAT_SECONDS = 6 * 60 * 60;

export type StallNoticeKind = 'stalled' | 'still_stalled' | 'recovered';

export interface StallNotice {
  kind: StallNoticeKind;
  job: string;
  text: string;
}

/** The pluggable "ops alert" sink. One implementation exists today (a GitHub issue comment); an email sink is a later row. */
export interface OpsAlertSink {
  send(notice: { kind: StallNoticeKind | 'invariant'; text: string }): Promise<void>;
}

const WAITING: Record<string, string> = {
  model_credits_revalidate: 'model connections marked out of credit are waiting for their re-check',
  sandbox_reap_terminal: 'finished sandboxes are waiting to be reaped (the last pass stopped on its budget)',
};

export function describeDuration(seconds: number): string {
  const minutes = Math.max(0, Math.floor(seconds / 60));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function stallText(kind: StallNoticeKind, lap: Pick<LapTime, 'name' | 'lapSeconds' | 'intervalSeconds'>): string {
  const since = describeDuration(lap.lapSeconds);
  const waiting = WAITING[lap.name] ?? 'work is waiting for it';
  if (kind === 'recovered') return `Recovered: reconcile job \`${lap.name}\` is passing again (or has nothing left to do).`;
  const lead = kind === 'stalled' ? 'Stalled' : 'Still stalled';
  return `${lead}: reconcile job \`${lap.name}\` has not completed a pass for ${since} (its cadence is about ${describeDuration(lap.intervalSeconds)}). Waiting: ${waiting}.`;
}

export interface StallCheckDeps {
  pool: Pool;
  sink: OpsAlertSink | null;
  /** Called with the sink's error; the caller keeps it off the database (stdout only). Never throws into the tick. */
  onSinkError(err: unknown): void;
  repeatSeconds?: number;
  work?: WorkOptions;
}

export interface StallCheckResult {
  stalled: string[];
  sent: StallNotice[];
  /** Jobs whose notice is outstanding after this check: the caller keeps the tick connecting until they recover. */
  outstanding: number;
}

/**
 * Atomic claim (two ticks can overlap): the state moves first, by an UPDATE that only matches the value this tick read, and a notice is posted only
 * when a row came back. A failed post puts the old value back. `old` is the column as text (exact microseconds), or null when no notice is outstanding.
 */
const CLAIM_SET = 'UPDATE reconcile_jobs SET stall_alerted_at = now() WHERE name = $1 AND stall_alerted_at::text IS NOT DISTINCT FROM $2 RETURNING name';
const CLAIM_CLEAR = 'UPDATE reconcile_jobs SET stall_alerted_at = NULL WHERE name = $1 AND stall_alerted_at::text IS NOT DISTINCT FROM $2 RETURNING name';
const RESTORE = 'UPDATE reconcile_jobs SET stall_alerted_at = $2::timestamptz WHERE name = $1';

export async function checkStalls(deps: StallCheckDeps): Promise<StallCheckResult> {
  const result: StallCheckResult = { stalled: [], sent: [], outstanding: 0 };
  const sink = deps.sink;
  if (sink === null) return result;
  const repeat = deps.repeatSeconds ?? STALL_REPEAT_SECONDS;
  const { laps, working } = await readLapState(deps.pool, deps.work);
  const { rows } = await deps.pool.query<{ name: string; age: number; at: string }>(
    'SELECT name, EXTRACT(EPOCH FROM (now() - stall_alerted_at))::float8 AS age, stall_alerted_at::text AS at FROM reconcile_jobs WHERE stall_alerted_at IS NOT NULL',
  );
  const outstanding = new Map(rows.map((r) => [r.name, r]));

  const deliver = async (kind: StallNoticeKind, lap: LapTime, old: string | null): Promise<void> => {
    const claim = await deps.pool.query(kind === 'recovered' ? CLAIM_CLEAR : CLAIM_SET, [lap.name, old]);
    if (claim.rows.length === 0) return; // another tick moved the state first: it posts, we do not
    const notice: StallNotice = { kind, job: lap.name, text: stallText(kind, lap) };
    try {
      await sink.send({ kind, text: notice.text });
    } catch (err) {
      // fx-swallow-ok: handed to onSinkError (stdout only); a sink failure must not fail the tick, and the restored state retries on a later tick
      deps.onSinkError(err);
      if (old === null) await deps.pool.query('UPDATE reconcile_jobs SET stall_alerted_at = NULL WHERE name = $1', [lap.name]);
      else await deps.pool.query(RESTORE, [lap.name, old]);
      return;
    }
    result.sent.push(notice);
    if (kind === 'recovered') outstanding.delete(lap.name);
    else outstanding.set(lap.name, { name: lap.name, age: 0, at: '' });
  };

  for (const lap of laps) {
    const isStalled = lap.breach && working.has(lap.name);
    if (isStalled) result.stalled.push(lap.name);
    const prior = outstanding.get(lap.name);
    if (isStalled && prior === undefined) await deliver('stalled', lap, null);
    else if (isStalled && prior !== undefined && prior.age >= repeat) await deliver('still_stalled', lap, prior.at);
    else if (!isStalled && prior !== undefined) await deliver('recovered', lap, prior.at);
  }
  result.outstanding = outstanding.size;
  return result;
}
