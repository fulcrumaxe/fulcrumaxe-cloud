import type { Pool, PoolClient } from 'pg';
import { withTenant } from './withTenant.js';

/**
 * Whether plan updates (write-back PRs) of a repo are merged automatically (D#598 P5c-a), over migrations/0967_plan_writeback_settings.sql.
 *
 * Append-only: every change is a new version row for the repo, and the audit row naming the previous and the new value is written in the
 * same transaction. Nothing here issues an UPDATE or a DELETE, and app_user holds neither. No row means off. Undo is a new version with
 * the other value. The `app.user_id` of the transaction is the actor and `changed_by`, never an input.
 */

/** What a repo does when no version has been written. */
export const PLAN_WRITEBACK_DEFAULT_AUTO_MERGE = false;

export type PlanWritebackSettingErrorCode = 'plan_writeback_repo_invalid' | 'plan_writeback_value_invalid' | 'plan_writeback_version_conflict';

/** Thrown before any write, or on a lost version race. `code` is the named error; branch on it, not on the message. */
export class PlanWritebackSettingError extends Error {
  constructor(readonly code: PlanWritebackSettingErrorCode) {
    super(code);
    this.name = 'PlanWritebackSettingError';
  }
}

export interface PlanWritebackSettingVersion {
  id: string;
  accountId: string;
  repoId: string;
  autoMerge: boolean;
  version: number;
  changedBy: string;
  createdAt: Date;
}

interface Row {
  id: string;
  account_id: string;
  repo_id: string;
  auto_merge: boolean;
  version: number;
  changed_by: string;
  created_at: Date;
}

const map = (r: Row): PlanWritebackSettingVersion => ({
  id: r.id,
  accountId: r.account_id,
  repoId: r.repo_id,
  autoMerge: r.auto_merge === true,
  version: r.version,
  changedBy: r.changed_by,
  createdAt: r.created_at,
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The CURRENT (highest-version) row for the repo, or null when none was ever written. RLS scopes it to the session's account. */
export async function getCurrentPlanWritebackSetting(client: PoolClient, repoId: string): Promise<PlanWritebackSettingVersion | null> {
  const { rows } = await client.query<Row>(`SELECT * FROM plan_writeback_settings WHERE repo_id = $1::uuid ORDER BY version DESC LIMIT 1`, [repoId]);
  return rows[0] ? map(rows[0]) : null;
}

export interface PlanWritebackMerge {
  /** The receipt's id. */
  id: string;
  at: Date;
  /** What the merge dial said when the platform merged: `act` (merged) or `announce` (merged and said so). */
  chosen: 'act' | 'announce';
}

/** The repo's newest plan updates the platform merged by policy (migration 0988), newest first: the receipts a person reads next to the switch. RLS scopes it to the session's account. */
export async function listPlanWritebackMerges(client: PoolClient, repoId: string, limit = 5): Promise<PlanWritebackMerge[]> {
  const { rows } = await client.query<{ id: string; created_at: Date; chosen: string }>(
    `SELECT r.id, r.created_at, r.chosen FROM plan_writeback_receipts l
       JOIN plan_writebacks w ON w.account_id = l.account_id AND w.id = l.plan_writeback_id
       JOIN decision_receipts r ON r.id = l.receipt_id
      WHERE w.repo_id = $1::uuid AND r.decision_type = 'merge_after_reviews' ORDER BY r.created_at DESC, r.id LIMIT $2::integer`,
    [repoId, limit],
  );
  return rows.map((r) => ({ id: r.id, at: r.created_at, chosen: r.chosen === 'announce' ? 'announce' : 'act' }));
}

/**
 * The reader the merge queue's tick uses: true only when the repo's current version says so; false when there is no row. The account is
 * named too, so a caller cannot read another account's row even on a client whose session is wider than one account.
 */
export async function readPlanWritebackAutoMerge(client: PoolClient, accountId: string, repoId: string): Promise<boolean> {
  const { rows } = await client.query<{ auto_merge: boolean }>(
    `SELECT auto_merge FROM plan_writeback_settings WHERE account_id = $1::uuid AND repo_id = $2::uuid ORDER BY version DESC LIMIT 1`,
    [accountId, repoId],
  );
  return rows[0]?.auto_merge === true;
}

export interface AppendPlanWritebackVersionInput {
  accountId: string;
  repoId: string;
  autoMerge: boolean;
  /** The authenticated caller; see `WritePlanWritebackContext`. */
  changedBy: string;
}

/**
 * Appends the next version and writes the audit row naming the previous and the new value, on a client that already holds a `withTenant`
 * transaction opened as `changedBy`. Setting the value already in force writes nothing and returns null: no version, no audit row.
 */
export async function appendPlanWritebackVersion(client: PoolClient, input: AppendPlanWritebackVersionInput): Promise<PlanWritebackSettingVersion | null> {
  const { accountId, repoId, autoMerge, changedBy } = input;
  if (!UUID_RE.test(repoId)) throw new PlanWritebackSettingError('plan_writeback_repo_invalid');
  if (typeof autoMerge !== 'boolean') throw new PlanWritebackSettingError('plan_writeback_value_invalid');
  // No FOR UPDATE: that needs UPDATE, which app_user deliberately lacks. A lost race fails on the UNIQUE key instead (mapped below).
  const previous = await getCurrentPlanWritebackSetting(client, repoId);
  const before = previous?.autoMerge ?? PLAN_WRITEBACK_DEFAULT_AUTO_MERGE;
  if (before === autoMerge) return null;
  let inserted: PlanWritebackSettingVersion;
  try {
    const { rows } = await client.query<Row>(
      `INSERT INTO plan_writeback_settings (account_id, repo_id, auto_merge, version, changed_by) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [accountId, repoId, autoMerge, previous ? previous.version + 1 : 1, changedBy],
    );
    inserted = map(rows[0]!);
  } catch (err) {
    // Two writers racing for one version: the loser fails on the UNIQUE key (23505) or on the next-version trigger (23514 with its own
    // message). Any other check violation is not a race and passes through.
    const e = err as { code?: string; message?: string } | null;
    if (e?.code === '23505' || (e?.code === '23514' && /^plan_writeback_settings\.version must be/.test(e.message ?? ''))) {
      throw new PlanWritebackSettingError('plan_writeback_version_conflict');
    }
    throw err;
  }
  await client.query(`SELECT audit_write('plan_writeback_setting.changed', $1::jsonb)`, [
    JSON.stringify({ actor: changedBy, repo_id: repoId, version: inserted.version, previous: before, new: autoMerge }),
  ]);
  return inserted;
}

export interface WritePlanWritebackContext {
  pool: Pool;
  /** The AUTHENTICATED caller's user id; never a request field. */
  principal: string;
}

/** One change as one transaction: the version row and its audit row commit together, or neither does. */
export async function writePlanWritebackAutoMerge(
  ctx: WritePlanWritebackContext,
  input: Omit<AppendPlanWritebackVersionInput, 'changedBy'>,
): Promise<PlanWritebackSettingVersion | null> {
  return withTenant(ctx.pool, input.accountId, ctx.principal, (client) => appendPlanWritebackVersion(client, { ...input, changedBy: ctx.principal }));
}
