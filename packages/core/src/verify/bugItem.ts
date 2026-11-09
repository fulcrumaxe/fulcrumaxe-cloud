import type { PoolClient } from 'pg';
import { cleanWorkItemTitle } from '../work-items/title.js';
import { JOURNEY_ID_RE, MAX_JOURNEYS, VerifyInputError } from './journeys.js';
import { attachBugItem } from './rows.js';

/**
 * D#749 V3b: the bug item a failed verify row files. One item per row, keyed on the row and its first failing journey (`verify:<row>:<journey>`, the same string
 * as pipeline's `bugItemKey`); the failed journey ids are named in the title. The title is made of ids that match JOURNEY_ID_RE and the merged pull request's number
 * and nothing a page, a tester or a Spec wrote, so no text from outside reaches an item's title or a later prompt through it. What the tester saw stays on the
 * row (its result), as data.
 *
 * Idempotent and without orphans: under one advisory lock keyed on the row and journey, in the caller's transaction, the item is inserted and then attached with
 * `attachBugItem`, whose set-once-on-a-failed-row rule the table enforces. A replay finds the row's item and files nothing; an attach that is refused throws, so the
 * caller's transaction rolls the insert back. The item enters the pipeline as the follow-up children do: kind `small`, the parent's provenance, the parent's
 * repository. A work item has no origin column, so `verify` cannot be named as its origin: its title and the row's `bug_item_id` tie it to the failure.
 */
export class BugItemNotAttachedError extends Error {
  readonly code = 'verify_bug_item_not_attached';
  constructor() {
    super('the bug item could not be attached to its row');
    this.name = 'BugItemNotAttachedError';
  }
}

export function bugItemLockKey(rowId: string, firstJourneyId: string): string {
  return `verify:${rowId}:${firstJourneyId}`;
}

export function bugItemTitle(prNumber: number, journeyIds: readonly string[]): string {
  const ids = journeyIds.slice(0, 8).join(', ');
  const more = journeyIds.length > 8 ? ` and ${journeyIds.length - 8} more` : '';
  return cleanWorkItemTitle(`Verify failed after PR #${prNumber}: ${ids}${more}`) ?? `Verify failed after PR #${prNumber}`;
}

export type FileBugResult = { filed: true; itemId: string } | { filed: false; itemId: string | null };

export async function fileBugItem(client: PoolClient, accountId: string, rowId: string, failedJourneyIds: readonly string[]): Promise<FileBugResult> {
  const ids = failedJourneyIds.filter((id) => JOURNEY_ID_RE.test(id)).slice(0, MAX_JOURNEYS);
  if (ids.length === 0 || ids.length !== failedJourneyIds.length) throw new VerifyInputError('verify_row_invalid', 'a bug item names the failed journeys by their ids');
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [bugItemLockKey(rowId, ids[0]!)]);
  const found = await client.query<{ status: string; bug_item_id: string | null; pr_number: number; repo_id: string; work_item_id: string }>(
    `SELECT status, bug_item_id, pr_number, repo_id, work_item_id FROM verify_rows WHERE id = $1 AND account_id = $2`,
    [rowId, accountId],
  );
  const row = found.rows[0];
  if (row === undefined || row.status !== 'failed') return { filed: false, itemId: null };
  if (row.bug_item_id !== null) return { filed: false, itemId: row.bug_item_id };
  return { filed: true, itemId: await insertAndAttach(client, accountId, rowId, row, ids) };
}

/** Inserts the item and attaches it. The attach is the guard: a row that already has an item, or is not failed, refuses it and the throw rolls the insert back with the caller's transaction. */
export async function insertAndAttach(client: PoolClient, accountId: string, rowId: string, row: { pr_number: number; repo_id: string; work_item_id: string }, ids: readonly string[]): Promise<string> {
  const parent = await client.query<{ provenance: string }>(`SELECT provenance FROM work_items WHERE id = $1 AND account_id = $2`, [row.work_item_id, accountId]);
  if (parent.rows[0] === undefined) throw new BugItemNotAttachedError();
  const item = await client.query<{ id: string }>(
    `INSERT INTO work_items (account_id, repo_id, kind, provenance, title) VALUES ($1, $2, 'small', $3, $4) RETURNING id`,
    [accountId, row.repo_id, parent.rows[0].provenance, bugItemTitle(row.pr_number, ids)],
  );
  const itemId = item.rows[0]!.id;
  if (!(await attachBugItem(client, accountId, rowId, itemId))) throw new BugItemNotAttachedError();
  return itemId;
}
