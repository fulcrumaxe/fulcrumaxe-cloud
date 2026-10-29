import type { Pool } from 'pg';

/** The most one notify pass lists; the definer refuses a limit outside 1..500 (migration 0930). */
export const ASK_NOTIFY_DEFAULT_LIMIT = 100;

export type AskNotifyKind = 'first' | 'reminder';

export interface AskNotifyDue {
  askId: string;
  accountId: string;
  /** `first`: an open ask never emailed. `reminder`: an overdue ask not yet reminded. */
  kind: AskNotifyKind;
  /** The ask's timeout outcome (an enum). The sender decides what a `proceed_recommended` ask gets. */
  timeoutOutcome: 'stop_and_flag' | 'proceed_recommended';
}

/**
 * The asks that need an email, across tenants, soonest window first (migration 0930, `ask_notify_due`). A read only: nothing is stamped here.
 * For the worker's tick only, on the RECEIPT pool with no tenant set. Ids and enums only; no question or option text leaves the database.
 */
export async function listAsksDueForNotify(pool: Pick<Pool, 'query'>, limit: number = ASK_NOTIFY_DEFAULT_LIMIT): Promise<AskNotifyDue[]> {
  const { rows } = await pool.query<{ o_ask_id: string; o_account_id: string; o_kind: AskNotifyKind; o_timeout_outcome: AskNotifyDue['timeoutOutcome'] }>(
    'SELECT o_ask_id, o_account_id, o_kind, o_timeout_outcome FROM ask_notify_due($1::integer)',
    [limit],
  );
  return rows.map((r) => ({ askId: r.o_ask_id, accountId: r.o_account_id, kind: r.o_kind, timeoutOutcome: r.o_timeout_outcome }));
}

/** Compare-and-set of `notified_at`: true only for the caller that moved it from NULL, false on a repeat or an ask that has ended. */
export async function stampAskNotified(pool: Pick<Pool, 'query'>, askId: string): Promise<boolean> {
  const { rows } = await pool.query<{ stamped: boolean }>('SELECT ask_stamp_notified($1::uuid) AS stamped', [askId]);
  return rows[0]?.stamped === true;
}

/** Compare-and-set of `renotified_at` for an overdue ask: true only for the caller that moved it from NULL. */
export async function stampAskRenotified(pool: Pick<Pool, 'query'>, askId: string): Promise<boolean> {
  const { rows } = await pool.query<{ stamped: boolean }>('SELECT ask_stamp_renotified($1::uuid) AS stamped', [askId]);
  return rows[0]?.stamped === true;
}

/** The distinct emails of one active account's owners and admins, when it has a pending ask; empty otherwise. Never a member. */
export async function listAccountNotifyRecipients(pool: Pick<Pool, 'query'>, accountId: string): Promise<string[]> {
  const { rows } = await pool.query<{ o_email: string }>('SELECT o_email FROM account_notify_recipients($1::uuid)', [accountId]);
  return rows.map((r) => r.o_email);
}
