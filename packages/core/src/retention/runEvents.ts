/**
 * D#45 C2 (S8): how long `run_events` are kept. This file is the only place
 * the number is written; every consumer (the export, the reminders, the
 * purge) reads it from here, and `test/unit/retention.test.ts` fails if the
 * literal shows up as a retention window anywhere else under packages/ or
 * apps/.
 */
export const RUN_EVENTS_RETENTION_DAYS = 90;

/** Backup reminders start once an account has events this old that no completed export covers. */
export const RUN_EVENTS_REMINDER_START_DAYS = 30;

/** The one surface `retentionDaysFor` reads through (a `PoolClient` or a `Pool` fits). */
export interface RetentionQueryable {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

/**
 * The window, in days, after which this account's run events may be purged.
 * 90 for every account until the paid extension (D#45 S10) lands, at which
 * point this reads the account's add-on state through `client`.
 */
export async function retentionDaysFor(_client: RetentionQueryable, _accountId: string): Promise<number> {
  return RUN_EVENTS_RETENTION_DAYS;
}
