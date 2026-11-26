import type { PoolClient } from 'pg';
import { ENGINE_STOP_REASONS } from '@fulcrumaxe/runner-protocol';
import { readEngineCoverage } from '../onboarding/engineCoverage.js';

/**
 * D#845 ON-13c4a: a stop that did not finish, derived on every read from the repo's newest session job. Nothing is stamped: a Try again, a later start or a later delete is a newer job, so it clears by itself.
 * Everything here is an enum, a closed failure code and a time; no text the engine wrote.
 */
export type StopReason = (typeof ENGINE_STOP_REASONS)[number];
export interface StopFailed {
  /** The signed stop reason; null when the stop carries one outside the closed list (a reason a later release adds). */
  reason: StopReason | null;
  code: string | null;
  at: string;
}

/** The repo's newest session job, as the read gives it. `at` is when it ended (when it was issued while no end is stored). */
export interface SessionJobFact {
  kind: string;
  state: string;
  stopReason: string | null;
  failureCode: string | null;
  at: Date | string;
}

/**
 * The newest session job of the repo (a superseded start is not newer news). Joined as `sj` onto a row `b` that carries `account_id` and `repo_id`, and read the same way for the list and for the retry route, so the two cannot disagree.
 * The account is named on the join as well as the repo, on top of row security.
 */
export const SESSION_JOB_LATERAL = `LEFT JOIN LATERAL (
         SELECT j.kind AS job_kind, j.state AS job_state, j.stop_reason AS job_stop_reason, j.failure_code AS job_failure_code, COALESCE(j.ended_at, j.issued_at) AS job_at
           FROM machine_jobs j
          WHERE j.account_id = b.account_id AND j.repo_id = b.repo_id AND j.kind IN ('engine_session_start', 'engine_session_stop', 'engine_session_delete')
            AND j.state IN ('issued', 'delivered', 'done', 'failed', 'expired')
          ORDER BY j.issued_at DESC, j.id DESC LIMIT 1) sj ON true`;

/** The sandbox is up (creating or running), the states the system stop lister uses. Joined on the account as well as the repo. */
export const SANDBOX_UP_SQL = `EXISTS (SELECT 1 FROM engine_session_sandboxes e WHERE e.account_id = b.account_id AND e.repo_id = b.repo_id AND e.state IN ('creating', 'running'))`;

/** The newest job and the sandbox of a row of the two reads above. */
export interface StopFacts {
  job: SessionJobFact | null;
  sandboxUp: boolean;
  watchEnabled: boolean;
  operateEnabled: boolean;
}

export const isSystemStopReason = (reason: string | null): reason is 'operate_off' | 'plan' => reason === 'operate_off' || reason === 'plan';

/** Whether the newest job is a stop that failed or went unanswered, and the sandbox is up: before any system cause is looked at. */
export function failedStopOf(f: Pick<StopFacts, 'job' | 'sandboxUp'>): SessionJobFact | null {
  const j = f.job;
  return j !== null && f.sandboxUp && j.kind === 'engine_session_stop' && (j.state === 'failed' || j.state === 'expired') ? j : null;
}

/** Whether a failed stop is one of `plan`'s, the only one that needs the plan read. */
export const needsPlanRead = (f: Pick<StopFacts, 'job' | 'sandboxUp'>): boolean => failedStopOf(f)?.stopReason === 'plan';

/**
 * Pure. `stop_failed` for one repo: the newest session job is a stop in `failed` or `expired`, and the sandbox is up. A system cause that no longer holds hides it: `operate_off` shows only while watch AND operate is not
 * both on, `plan` only while the plan has ended (`planEnded`, read by the caller, only when `needsPlanRead`).
 */
export function stopFailedOf(f: StopFacts, planEnded: boolean): StopFailed | null {
  const j = failedStopOf(f);
  if (j === null) return null;
  if (j.stopReason === 'operate_off' && f.watchEnabled && f.operateEnabled) return null;
  if (j.stopReason === 'plan' && !planEnded) return null;
  const reason = (ENGINE_STOP_REASONS as readonly string[]).includes(j.stopReason ?? '') ? (j.stopReason as StopReason) : null;
  return { reason, code: j.failureCode, at: new Date(j.at).toISOString() };
}

/** The newest job row of the join, as the fact. */
export const jobFactOf = (r: { job_kind: string | null; job_state: string | null; job_stop_reason: string | null; job_failure_code: string | null; job_at: Date | string | null }): SessionJobFact | null =>
  r.job_kind === null || r.job_state === null || r.job_at === null ? null : { kind: r.job_kind, state: r.job_state, stopReason: r.job_stop_reason, failureCode: r.job_failure_code, at: r.job_at };

/** One repo's facts, for the retry route. The repo need not be ticked (the list hides an unticked one; the route still answers for it). */
export async function readStopFacts(client: PoolClient, accountId: string, repoId: string): Promise<StopFacts> {
  const row = (await client.query(
    `SELECT sj.job_kind, sj.job_state, sj.job_stop_reason, sj.job_failure_code, sj.job_at, ${SANDBOX_UP_SQL} AS sandbox_up,
            COALESCE(st.watch_enabled, false) AS watch_enabled, COALESCE(st.operate_enabled, false) AS operate_enabled
       FROM (SELECT $1::uuid AS account_id, $2::uuid AS repo_id) b
       ${SESSION_JOB_LATERAL}
       LEFT JOIN engine_bridge_settings st ON st.account_id = b.account_id`,
    [accountId, repoId],
  )).rows[0];
  return { job: jobFactOf(row), sandboxUp: row.sandbox_up === true, watchEnabled: row.watch_enabled === true, operateEnabled: row.operate_enabled === true };
}

/** Whether the account's Engine plan has ended (the only state in which a failed `plan` stop still shows). */
export async function planHasEnded(client: PoolClient, accountId: string): Promise<boolean> {
  return (await readEngineCoverage(client, accountId, false)).state === 'plan_ended';
}
