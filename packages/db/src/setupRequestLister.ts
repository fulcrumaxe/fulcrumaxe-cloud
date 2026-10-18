import type { Pool } from 'pg';

/**
 * D#598 P8b: the cross-account list of setup requests that are due for their automatic check (migration 0874,
 * `setup_request_list_due`). Call it on the RUN-WRITER pool (the runner login: `agent_run_writer` holds EXECUTE; `app_user`, `platform_ops` and
 * every other role are refused) with no tenant set. It answers ids and one fixed word, nothing a person or an agent wrote; the request itself is
 * read afterwards, one at a time, under its own tenant.
 */

/** The cron runs once a minute; a request is due 45 seconds after its last check, so a tick a few seconds early still finds it. */
export const SETUP_REQUEST_DUE_AFTER_SECONDS = 45;
/** The most one call returns (the definer refuses more than 200). */
export const SETUP_REQUEST_LIST_DUE_LIMIT = 50;

export interface DueSetupRequest {
  accountId: string;
  setupRequestId: string;
  kind: string;
}

/** One statement, an index scan: when nothing is due the answer is an empty list. */
export async function listDueSetupRequests(
  pool: Pick<Pool, 'query'>,
  opts: { limit?: number; minAgeSeconds?: number } = {},
): Promise<DueSetupRequest[]> {
  const { rows } = await pool.query<{ account_id: string; setup_request_id: string; kind: string }>(
    'SELECT account_id, setup_request_id, kind FROM setup_request_list_due($1::integer, $2::integer)',
    [opts.limit ?? SETUP_REQUEST_LIST_DUE_LIMIT, opts.minAgeSeconds ?? SETUP_REQUEST_DUE_AFTER_SECONDS],
  );
  return rows.map((r) => ({ accountId: r.account_id, setupRequestId: r.setup_request_id, kind: r.kind }));
}
