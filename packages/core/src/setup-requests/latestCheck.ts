import type { PoolClient } from 'pg';
import { checkReasonSentence, isCheckReasonCode, type CheckReasonCode } from './copy.js';
import { TARGET_ENVIRONMENTS, type TargetEnvironment } from './kinds.js';

/**
 * D#598 P8d-3a: what the most recent env-var check found, for the Vercel connection screen. Derived on every read from the setup-request rows;
 * nothing is stamped for it. A check that ran before the connection's current token was connected or replaced does not count (it says nothing
 * about this token), so replacing the token or reconnecting clears a stale "revoked" without any write.
 *
 * A request counts when it is open with a check reason (the check said "not yet" or could not read), or closed by the check itself
 * (`check_passed`). A request a person marked done carries a stale reason and is left out. Runs under the caller's tenant client.
 */
export interface LatestVercelCheck {
  /**
   * What the check says about the TOKEN: `read` (it listed the project; the variable may or may not be set), `cannot_read` (Vercel refused this
   * token that project), `token_rejected` (Vercel does not accept the token: revoked or expired), `unreachable` (Vercel could not be asked).
   */
  result: 'read' | 'cannot_read' | 'token_rejected' | 'unreachable';
  /** The fixed reason code when the check did not pass; null for a pass. */
  reason: CheckReasonCode | null;
  /** Plain words for the screen, built from the request's structured fields only. */
  sentence: string;
  project: string;
  ranAt: Date;
}

interface Row {
  target: string;
  env_name: string | null;
  target_environment: TargetEnvironment;
  state: string;
  check_reason: string | null;
  check_ran_at: Date;
}

const RESULT_OF: Record<CheckReasonCode, LatestVercelCheck['result']> = {
  env_var_missing: 'read',
  env_var_wrong_target: 'read',
  token_cannot_read: 'cannot_read',
  token_rejected: 'token_rejected',
  check_unavailable: 'unreachable',
};

export async function getLatestVercelCheck(client: PoolClient, accountId: string, since: Date): Promise<LatestVercelCheck | null> {
  const { rows } = await client.query<Row>(
    `SELECT target, env_name, target_environment, state, check_reason, check_ran_at
       FROM setup_requests
      WHERE account_id = $1 AND check_kind IS NOT NULL AND check_ran_at >= $2
        AND ((state = 'open' AND check_reason IS NOT NULL) OR (state = 'done' AND resolution = 'check_passed'))
      ORDER BY check_ran_at DESC, created_at DESC LIMIT 1`,
    [accountId, since],
  );
  const row = rows[0];
  if (!row || !TARGET_ENVIRONMENTS.includes(row.target_environment)) return null;
  const name = row.env_name ?? row.target;
  if (row.state === 'done') return { result: 'read', reason: null, sentence: `${name} is set on ${row.target}.`, project: row.target, ranAt: row.check_ran_at };
  if (!isCheckReasonCode(row.check_reason)) return null;
  return {
    result: RESULT_OF[row.check_reason],
    reason: row.check_reason,
    sentence: checkReasonSentence(row.check_reason, { name, project: row.target, environment: row.target_environment }),
    project: row.target,
    ranAt: row.check_ran_at,
  };
}
