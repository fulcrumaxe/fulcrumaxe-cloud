import type { Pool, PoolClient } from 'pg';
import {
  ASK_NOTIFY_VALUES,
  ASK_WINDOW_MAX_MINUTES,
  ASK_WINDOW_MIN_MINUTES,
  TIMEOUT_OUTCOMES,
  getCatalogueEntry,
  resolveAskPolicy,
  type AskNotify,
  type AskPolicy,
  type AskSettingRow,
  type PresetName,
  type TimeoutOutcome,
} from '@fx/decisions';
import { withTenant } from './withTenant.js';

/**
 * The customer's ask settings (D#7 DP12a-1, DP-C5 R3 and R5), over migrations/0812_decision_ask_settings.sql.
 *
 * Append-only (C8): every change is a new version row, and the audit row naming the previous and the new values is written in the same
 * transaction. Nothing here issues an UPDATE or a DELETE, and app_user holds neither. A version holds the three values for ONE key
 * `(repo or account, decision type or '*')`; a null value means "not set here, inherit" (resolveAskPolicy walks the levels). Undo is a
 * new version: set the earlier values again, or null all three to remove the override.
 *
 * The `app.user_id` of the transaction is the actor and `changed_by`, never an input (the policy requires them to be equal, and to be an
 * owner or admin of the account).
 */

export type AskSettingErrorCode =
  | 'ask_setting_unknown_decision_type'
  | 'ask_setting_class1_never_asks'
  | 'ask_setting_window_out_of_range'
  | 'ask_setting_outcome_invalid'
  | 'ask_setting_outcome_not_allowed'
  | 'ask_setting_notify_invalid'
  | 'ask_setting_repo_invalid'
  | 'ask_setting_version_conflict';

/** Thrown before any write, or on a lost version race. `code` is the named error; branch on it, not on the message. */
export class AskSettingError extends Error {
  constructor(readonly code: AskSettingErrorCode) {
    super(code);
    this.name = 'AskSettingError';
  }
}

export interface AskSettingVersion {
  id: string;
  accountId: string;
  repoId: string | null;
  decisionType: string;
  answerWindowMinutes: number | null;
  timeoutOutcome: TimeoutOutcome | null;
  notify: AskNotify | null;
  version: number;
  changedBy: string;
  createdAt: Date;
}

interface Row {
  id: string;
  account_id: string;
  repo_id: string | null;
  decision_type: string;
  answer_window_minutes: number | null;
  timeout_outcome: TimeoutOutcome | null;
  notify: AskNotify | null;
  version: number;
  changed_by: string;
  created_at: Date;
}

const map = (r: Row): AskSettingVersion => ({
  id: r.id,
  accountId: r.account_id,
  repoId: r.repo_id,
  decisionType: r.decision_type,
  answerWindowMinutes: r.answer_window_minutes,
  timeoutOutcome: r.timeout_outcome,
  notify: r.notify,
  version: r.version,
  changedBy: r.changed_by,
  createdAt: r.created_at,
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The CURRENT (highest-version) row for every key the tenant has written. RLS scopes it to the transaction's account. */
export async function listCurrentAskSettings(client: PoolClient): Promise<AskSettingVersion[]> {
  const { rows } = await client.query<Row>(
    `SELECT DISTINCT ON (repo_id, decision_type) *
       FROM decision_ask_settings
      ORDER BY repo_id NULLS FIRST, decision_type, version DESC`,
  );
  return rows.map(map);
}

/** Every version ever written for one key, oldest first: the full history, not just current state. */
export async function listAskSettingHistory(
  client: PoolClient,
  repoId: string | null,
  decisionType: string,
): Promise<AskSettingVersion[]> {
  const { rows } = await client.query<Row>(
    `SELECT * FROM decision_ask_settings
      WHERE repo_id IS NOT DISTINCT FROM $1::uuid AND decision_type = $2
      ORDER BY version ASC`,
    [repoId, decisionType],
  );
  return rows.map(map);
}

/** The rows resolveAskPolicy takes: the current version of each key, as the pure resolver's shape. */
export function toAskSettingRows(current: readonly AskSettingVersion[]): AskSettingRow[] {
  return current.map((v) => ({
    repoId: v.repoId,
    decisionType: v.decisionType,
    answerWindowMinutes: v.answerWindowMinutes,
    timeoutOutcome: v.timeoutOutcome,
    notify: v.notify,
  }));
}

export interface AskSettingValues {
  /** 15 minutes to 14 days, or null to inherit. */
  answerWindowMinutes: number | null;
  /** Only an outcome the catalogue entry permits, or null to inherit. For '*' either value is stored and the resolver clamps per entry. */
  timeoutOutcome: TimeoutOutcome | null;
  notify: AskNotify | null;
}

export interface WriteAskSettingContext {
  pool: Pool;
  /** The AUTHENTICATED caller's user id; never a request field. */
  principal: string;
}

export interface WriteAskSettingInput extends AskSettingValues {
  accountId: string;
  /** Null is the account level. */
  repoId: string | null;
  /** A class 2 or 3 catalogue id, or '*'. */
  decisionType: string;
}

function validate(input: AskSettingValues & { repoId: string | null; decisionType: string }): void {
  if (input.repoId !== null && !UUID_RE.test(input.repoId)) throw new AskSettingError('ask_setting_repo_invalid');
  const entry = input.decisionType === '*' ? null : (getCatalogueEntry(input.decisionType) ?? null);
  if (input.decisionType !== '*') {
    if (!entry) throw new AskSettingError('ask_setting_unknown_decision_type');
    if (entry.class === 'automated_with_monitoring') throw new AskSettingError('ask_setting_class1_never_asks');
  }
  const w = input.answerWindowMinutes;
  if (w !== null && (!Number.isInteger(w) || w < ASK_WINDOW_MIN_MINUTES || w > ASK_WINDOW_MAX_MINUTES)) {
    throw new AskSettingError('ask_setting_window_out_of_range');
  }
  const o = input.timeoutOutcome;
  if (o !== null) {
    if (!TIMEOUT_OUTCOMES.includes(o)) throw new AskSettingError('ask_setting_outcome_invalid');
    if (entry && !entry.timeoutOutcomes.includes(o)) throw new AskSettingError('ask_setting_outcome_not_allowed');
  }
  if (input.notify !== null && !ASK_NOTIFY_VALUES.includes(input.notify)) throw new AskSettingError('ask_setting_notify_invalid');
}

/**
 * Appends the next version of one key and writes the audit row naming the previous and the new values, on a client that already holds a
 * `withTenant` transaction opened as `changedBy`. Several keys can be written in one commit by calling it more than once.
 */
export async function appendAskSettingVersion(
  client: PoolClient,
  input: WriteAskSettingInput & { changedBy: string },
): Promise<AskSettingVersion> {
  validate(input);
  const { accountId, repoId, decisionType, answerWindowMinutes, timeoutOutcome, notify, changedBy } = input;
  // No FOR UPDATE: that needs UPDATE, which app_user deliberately lacks. A lost race fails on the UNIQUE key instead (mapped below).
  const { rows: prev } = await client.query<Row>(
    `SELECT * FROM decision_ask_settings
      WHERE account_id = $1 AND repo_id IS NOT DISTINCT FROM $2::uuid AND decision_type = $3
      ORDER BY version DESC LIMIT 1`,
    [accountId, repoId, decisionType],
  );
  const previous = prev[0] ? map(prev[0]) : null;
  let inserted: AskSettingVersion;
  try {
    const { rows } = await client.query<Row>(
      `INSERT INTO decision_ask_settings
         (account_id, repo_id, decision_type, answer_window_minutes, timeout_outcome, notify, version, changed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [accountId, repoId, decisionType, answerWindowMinutes, timeoutOutcome, notify, previous ? previous.version + 1 : 1, changedBy],
    );
    inserted = map(rows[0]!);
  } catch (err) {
    // Two writers racing for one version: the loser fails on the UNIQUE key (23505) or, if the winner had already committed, on the
    // next-version trigger (23514 with its own message). Any other check violation is not a race and passes through.
    const e = err as { code?: string; message?: string } | null;
    if (e?.code === '23505' || (e?.code === '23514' && /^decision_ask_settings\.version must be/.test(e.message ?? ''))) {
      throw new AskSettingError('ask_setting_version_conflict');
    }
    throw err;
  }
  const values = (v: AskSettingValues | null) => ({
    answer_window_minutes: v?.answerWindowMinutes ?? null,
    timeout_outcome: v?.timeoutOutcome ?? null,
    notify: v?.notify ?? null,
  });
  await client.query(`SELECT audit_write('decision_ask_setting.changed', $1::jsonb)`, [
    JSON.stringify({
      actor: changedBy,
      repo_id: repoId,
      decision_type: decisionType,
      version: inserted.version,
      previous: values(previous),
      new: values(inserted),
    }),
  ]);
  return inserted;
}

/** One setting change as one transaction: the version row and its audit row commit together, or neither does. */
export async function writeAskSetting(ctx: WriteAskSettingContext, input: WriteAskSettingInput): Promise<AskSettingVersion> {
  return withTenant(ctx.pool, input.accountId, ctx.principal, (client) =>
    appendAskSettingVersion(client, { ...input, changedBy: ctx.principal }),
  );
}

/**
 * The policy tuple for a new ask: the work item's repository and the account's current settings, resolved by the pure resolver. `client`
 * is the raiser's tenant transaction. An unknown work item resolves with account-level rows only.
 */
export async function resolveAskPolicyForWorkItem(
  client: PoolClient,
  input: { decisionType: string; workItemId: string; preset: PresetName },
): Promise<AskPolicy> {
  const entry = getCatalogueEntry(input.decisionType);
  if (!entry) throw new AskSettingError('ask_setting_unknown_decision_type');
  const { rows } = await client.query<{ repo_id: string | null }>(`SELECT repo_id FROM work_items WHERE id = $1::uuid`, [input.workItemId]);
  const current = await listCurrentAskSettings(client);
  return resolveAskPolicy(entry, input.preset, toAskSettingRows(current), rows[0]?.repo_id ?? null);
}
