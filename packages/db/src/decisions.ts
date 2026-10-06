import type { Pool, PoolClient } from 'pg';
import { withTenant } from './withTenant.js';

/**
 * Typed reads and the append-only dial write over the two tables
 * migrations/0400_decisions.sql creates (D#7 task DP2). Receipt WRITES are
 * deliberately not here: `app_user` holds no INSERT on `decision_receipts`
 * at all (DP2 item 4, C4) -- that credential belongs to DP3's
 * `receipt_writer` role and `src/receiptWriter.ts`, neither of which this
 * task builds. `listReceiptsForWorkItem` below is a read, which app_user
 * does hold.
 */

export interface DecisionSetting {
  id: string;
  accountId: string;
  repoId: string;
  decisionType: string;
  disposition: string;
  preset: string | null;
  version: number;
  changedBy: string;
  createdAt: Date;
}

export type DecisionClass =
  | 'automated_with_monitoring'
  | 'human_over_the_loop'
  | 'human_in_the_loop';

export interface DecisionReceipt {
  id: string;
  accountId: string;
  runId: string | null;
  workItemId: string | null;
  decisionType: string;
  class: DecisionClass;
  chosen: string | null;
  rejectedAlternative: string | null;
  dialVersion: number | null;
  inputTrustClasses: unknown;
  actor: string | null;
  reversalState: string | null;
  createdAt: Date;
}

interface DecisionSettingRow {
  id: string;
  account_id: string;
  repo_id: string;
  decision_type: string;
  disposition: string;
  preset: string | null;
  version: number;
  changed_by: string;
  created_at: Date;
}

function mapDecisionSettingRow(row: DecisionSettingRow): DecisionSetting {
  return {
    id: row.id,
    accountId: row.account_id,
    repoId: row.repo_id,
    decisionType: row.decision_type,
    disposition: row.disposition,
    preset: row.preset,
    version: row.version,
    changedBy: row.changed_by,
    createdAt: row.created_at,
  };
}

interface DecisionReceiptRow {
  id: string;
  account_id: string;
  run_id: string | null;
  work_item_id: string | null;
  decision_type: string;
  class: string;
  chosen: string | null;
  rejected_alternative: string | null;
  dial_version: number | null;
  input_trust_classes: unknown;
  actor: string | null;
  reversal_state: string | null;
  created_at: Date;
}

function mapDecisionReceiptRow(row: DecisionReceiptRow): DecisionReceipt {
  return {
    id: row.id,
    accountId: row.account_id,
    runId: row.run_id,
    workItemId: row.work_item_id,
    decisionType: row.decision_type,
    class: row.class as DecisionClass,
    chosen: row.chosen,
    rejectedAlternative: row.rejected_alternative,
    dialVersion: row.dial_version,
    inputTrustClasses: row.input_trust_classes,
    actor: row.actor,
    reversalState: row.reversal_state,
    createdAt: row.created_at,
  };
}

/**
 * The CURRENT (highest-version) decision_settings row for
 * `(repoId, decisionType)`, or `null` if no dial has ever been written for
 * that key -- meaning the catalogue's `defaultDisposition` (packages/decisions,
 * DP1) applies. `client` must come from `withTenant`/`withPartner` (or any
 * connection with `app.account_id` already set): RLS scopes the result to
 * whichever account that transaction set, the same as every other tenant
 * read in this package.
 */
export async function getCurrentDialSetting(
  client: PoolClient,
  repoId: string,
  decisionType: string,
): Promise<DecisionSetting | null> {
  const { rows } = await client.query<DecisionSettingRow>(
    `SELECT * FROM decision_settings
     WHERE repo_id = $1 AND decision_type = $2
     ORDER BY version DESC
     LIMIT 1`,
    [repoId, decisionType],
  );
  return rows[0] ? mapDecisionSettingRow(rows[0]) : null;
}

/** Every version ever written for `(repoId, decisionType)`, oldest first -- the full history, not just current state. */
export async function listDialHistory(
  client: PoolClient,
  repoId: string,
  decisionType: string,
): Promise<DecisionSetting[]> {
  const { rows } = await client.query<DecisionSettingRow>(
    `SELECT * FROM decision_settings
     WHERE repo_id = $1 AND decision_type = $2
     ORDER BY version ASC`,
    [repoId, decisionType],
  );
  return rows.map(mapDecisionSettingRow);
}

/**
 * `(ctx, input)` shape (D#2 C7 / H12): the caller's identity is `ctx`
 * context, never request input. `principal` MUST be the AUTHENTICATED
 * caller's own user id -- never a value taken from the request body --
 * because it becomes both `app.user_id` (via `withTenant`) and
 * `decision_settings.changed_by` for this write. Fix round, D#7 DP2, PR
 * #54: the original signature took a free `changedBy` field on the input
 * instead, which let ANY caller reaching this function claim to be a
 * different, more privileged user -- migrations/0400_decisions.sql's
 * `owner_or_admin_insert` policy checked only that `changed_by` NAMED a
 * real owner/admin, never that it WAS the caller. Binding identity to
 * `ctx.principal` here, and the policy's own new `changed_by =
 * app.user_id` conjunct, close that hole at both layers.
 */
export interface WriteDialSettingContext {
  pool: Pool;
  principal: string;
}

export interface WriteDialSettingInput {
  accountId: string;
  repoId: string;
  decisionType: string;
  disposition: string;
  preset?: string | null;
}

/**
 * Writes the next version of a dial (DP2 items 1 and 6, C8): reads the
 * current highest version for `(repoId, decisionType)`, inserts a new
 * `decision_settings` row one version higher, and records the change as an
 * `audit_log` row naming the actor and both the previous and new
 * disposition -- all inside one transaction opened via `withTenant`, so an
 * owner/admin-gated rejection never produces a partial audit trail (the
 * whole transaction, including the `audit_write` call, rolls back with the
 * rejected INSERT). The actor is always `ctx.principal` -- see
 * `WriteDialSettingContext` above for why there is no `changedBy` input.
 *
 * D#76: the audit row no longer goes through a raw `INSERT INTO
 * audit_log` -- app_user's INSERT grant on that table was revoked, so
 * this now goes through `audit_write()`, the SECURITY DEFINER function
 * that stamps `account_id`/`actor`/`created_at` itself rather than
 * trusting the caller. `changedBy` is still passed inside the payload's
 * `actor` key for parity with the pre-D#76 row shape (existing readers,
 * e.g. decisions-dial-write.test.ts, read `payload.actor`), even though
 * `audit_write()` would overwrite that key with the SAME value regardless
 * of what's submitted here.
 */
export async function writeDialSetting(
  ctx: WriteDialSettingContext,
  input: WriteDialSettingInput,
): Promise<DecisionSetting> {
  const { pool, principal: changedBy } = ctx;
  const { accountId, repoId, decisionType, disposition } = input;
  const preset = input.preset ?? null;

  return withTenant(pool, accountId, changedBy, async (client) => {
    // Deliberately NOT "... FOR UPDATE": Postgres requires the UPDATE
    // privilege (not just SELECT) to take a row lock via a locking clause,
    // and app_user is deliberately never granted UPDATE on
    // decision_settings at all (DP2 item 2, C8) -- a FOR UPDATE here would
    // make every legitimate owner/admin write fail with "permission denied"
    // before it ever reached the owner/admin check. Two concurrent writers
    // for the same (repoId, decisionType) key can therefore both read the
    // same "current" version and both compute the same nextVersion; the
    // loser is caught instead by decision_settings' UNIQUE (account_id,
    // repo_id, decision_type, version) constraint, failing with a 23505
    // unique violation rather than silently overwriting the winner's row.
    const { rows: previousRows } = await client.query<DecisionSettingRow>(
      `SELECT * FROM decision_settings
       WHERE account_id = $1 AND repo_id = $2 AND decision_type = $3
       ORDER BY version DESC
       LIMIT 1`,
      [accountId, repoId, decisionType],
    );
    const previous = previousRows[0] ? mapDecisionSettingRow(previousRows[0]) : null;
    const nextVersion = previous ? previous.version + 1 : 1;

    const { rows: insertedRows } = await client.query<DecisionSettingRow>(
      `INSERT INTO decision_settings
         (account_id, repo_id, decision_type, disposition, preset, version, changed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [accountId, repoId, decisionType, disposition, preset, nextVersion, changedBy],
    );
    const inserted = mapDecisionSettingRow(insertedRows[0]!);

    await client.query(
      `SELECT audit_write('decision_dial_changed', $1::jsonb)`,
      [
        JSON.stringify({
          actor: changedBy,
          decision_type: decisionType,
          repo_id: repoId,
          previous: previous ? previous.disposition : null,
          new: disposition,
        }),
      ],
    );

    return inserted;
  });
}

/** Receipts for one work item, newest first -- a typed read over decision_receipts (app_user is SELECT-only; see migrations/0400_decisions.sql). */
export async function listReceiptsForWorkItem(
  client: PoolClient,
  workItemId: string,
): Promise<DecisionReceipt[]> {
  const { rows } = await client.query<DecisionReceiptRow>(
    `SELECT * FROM decision_receipts WHERE work_item_id = $1 ORDER BY created_at DESC`,
    [workItemId],
  );
  return rows.map(mapDecisionReceiptRow);
}

/** DP-OD5: class-2/class-3 receipts are retained for 24 months, independent of run retention. */
export const RECEIPT_RETENTION_MONTHS = 24;

export interface PruneResult {
  deleted: number;
}

/**
 * Deletes `decision_receipts` rows older than `retentionMonths` (default
 * `RECEIPT_RETENTION_MONTHS`, DP2 item 8 / DP-OD5 / C5) -- a plain
 * `created_at` cutoff on this table alone, with no join to `agent_runs` or
 * any other retention job, so it stays independent of run retention by
 * construction rather than by convention.
 *
 * No application role (`app_user`, or DP3's `receipt_writer`) holds DELETE
 * on `decision_receipts` -- this is deliberate (see migrations/
 * 0400_decisions.sql). `client` here must therefore be an admin/
 * migration-owner connection, the same kind `src/migrate.ts` uses, not a
 * tenant-scoped `withTenant()` connection -- an ops/cron job's job, not
 * something reachable from a tenant session or an agent's tool surface.
 *
 * Fix round 3 (D#7 DP2, security review needs-fix on PR #54, SUGGESTION
 * item 6): `retentionMonths` used to be passed straight into the query
 * with no floor, so a caller-supplied `0` or a negative number deleted
 * every receipt regardless of age -- this is only reachable from an
 * admin/migration-owner connection, never `app_user`, but a mistaken
 * argument on that path is exactly what an accidental early deletion of
 * evidence looks like. This now refuses any value below
 * `RECEIPT_RETENTION_MONTHS` (24, DP-OD5's floor) before running the
 * query at all -- no partial deletion happens on a rejected call.
 */
export async function pruneDecisionReceipts(
  client: PoolClient,
  retentionMonths: number = RECEIPT_RETENTION_MONTHS,
): Promise<PruneResult> {
  if (retentionMonths < RECEIPT_RETENTION_MONTHS) {
    throw new Error(
      `pruneDecisionReceipts: retentionMonths (${retentionMonths}) is below the DP-OD5 floor of ${RECEIPT_RETENTION_MONTHS} months`,
    );
  }
  const { rowCount } = await client.query(
    `DELETE FROM decision_receipts WHERE created_at < now() - make_interval(months => $1)`,
    [retentionMonths],
  );
  return { deleted: rowCount ?? 0 };
}
