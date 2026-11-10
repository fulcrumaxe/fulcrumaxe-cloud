import type { PoolClient } from 'pg';
import { ACCOUNT_CHECKS, VERIFY_METHODS, VERIFY_REASON_CODES, VERIFY_ROW_STATUSES, type AccountCheck, type JourneyResult, type VerifyMethod, type VerifyReasonCode, type VerifyRowStatus } from '../verify/rows.js';

/**
 * D#749 V4b: the verify section of an item's activity read. The newest verify row of the item (one row per merge), read only, from `verify_rows` and
 * `verify_settings` under the caller's tenant: the tables' own row-level security scopes the account, and a member may read both (only a write needs an
 * owner or admin). Nothing is stored for the card; every read derives the section from the rows.
 *
 * The section exists only while verification is ON for the item's repository. A repository that never turned it on, or that turned it off, has no section
 * (the undo path: switching it off takes the section away on the next read). A repository with no row for the item has none either.
 *
 * Only closed values reach the answer: the status, a reason code from the table's own list, the method, three journey counts, a three-way account word, the bug
 * item's id and the pull request number. Nothing a page, a tester or a Spec wrote leaves the row (the journey text and the steps stay on it), and neither does the
 * configured address or the test account's name.
 */
export interface ItemVerify {
  status: VerifyRowStatus;
  /** The closed reason of an `unverified` row; null for every other status (a row that has not started has none). */
  reason: VerifyReasonCode | null;
  method: VerifyMethod | null;
  /** The journeys' outcomes for a finished `verified` or `failed` row; null otherwise (an unverified row's results are not trusted: the check could not be made). */
  journeys: { total: number; passed: number; failed: number; other: number } | null;
  /**
   * What the account check found when the row settled, as the stage stored it (migration 1009): `matched` (the trusted verify server recorded exactly the test account the
   * repository named), `mismatch` or `unverifiable`. Null when the account was not judged: no test account was set for that run, the row ended before the check, or it
   * finished before the word was stored. The repository's current settings play no part: a label set afterwards changes nothing.
   */
  account: AccountCheck | null;
  /** The bug item a failed row filed, or null. */
  bug_item_id: string | null;
  pr_number: number;
  /** When the row finished, else when it was opened. */
  at: string;
}

interface Row {
  status: VerifyRowStatus;
  method: VerifyMethod | null;
  reason_code: VerifyReasonCode | null;
  result: JourneyResult[] | null;
  bug_item_id: string | null;
  pr_number: number;
  finished_at: Date | null;
  created_at: Date;
  account_check: AccountCheck | null;
}

function countJourneys(result: JourneyResult[] | null): ItemVerify['journeys'] {
  if (result === null || !Array.isArray(result)) return null;
  const passed = result.filter((r) => r.result === 'pass').length;
  const failed = result.filter((r) => r.result === 'fail').length;
  return { total: result.length, passed, failed, other: result.length - passed - failed };
}

/** The item's newest verify row, or null when verification is off for its repository or the item has no row (the answer then carries no `verify`). */
export async function readItemVerify(client: Pick<PoolClient, 'query'>, workItemId: string): Promise<ItemVerify | null> {
  const { rows } = await client.query<Row>(
    `SELECT r.status, r.method, r.reason_code, r.result, r.bug_item_id, r.pr_number, r.finished_at, r.created_at, r.account_check
       FROM verify_rows r
       JOIN verify_settings s ON s.repo_id = r.repo_id AND s.account_id = r.account_id AND s.enabled
      WHERE r.work_item_id = $1::uuid
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT 1`,
    [workItemId],
  );
  const r = rows[0];
  if (r === undefined || !VERIFY_ROW_STATUSES.includes(r.status)) return null;
  const finishedWithResult = r.status === 'verified' || r.status === 'failed';
  const reason = r.status === 'unverified' && r.reason_code !== null && VERIFY_REASON_CODES.includes(r.reason_code) ? r.reason_code : null;
  return {
    status: r.status,
    reason,
    method: r.method !== null && VERIFY_METHODS.includes(r.method) ? r.method : null,
    journeys: finishedWithResult ? countJourneys(r.result) : null,
    account: r.account_check !== null && ACCOUNT_CHECKS.includes(r.account_check) ? r.account_check : null,
    bug_item_id: r.bug_item_id,
    pr_number: r.pr_number,
    at: (r.finished_at ?? r.created_at).toISOString(),
  };
}
