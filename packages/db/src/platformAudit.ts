import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

/**
 * The platform_audit writer, using the receipt_writer precedent (D#7
 * DP3's Spec text: "a credential the agent's tool surface cannot reach").
 * `platform_audit` (migrations/0611_exposure_audit.sql, D#8 R1 criterion
 * 5) is the append-only, cross-tenant audit trail for platform-wide
 * actions -- `audit_log.account_id` is `NOT NULL`, so a platform-wide
 * action (the emergency floor path, a cross-account admin decision) has
 * no legal row shape there. `app_user` holds NOTHING on this table at
 * all, not even SELECT; `platform_ops` holds SELECT only; `exposure_writer`
 * holds INSERT and nothing else -- the same role D#8 R1's
 * `exposure.ts` uses for `account_features` writes, not a second writer
 * role (Implementation Notes: "not a fourth idiom").
 */

export interface PlatformAuditEntry {
  id: string;
  accountId: string | null;
  actorUserId: string;
  action: string;
  advisoryRef: string | null;
  previousValue: unknown;
  newValue: unknown;
  authorisedBy: unknown;
  createdAt: Date;
}

interface PlatformAuditRow {
  id: string;
  account_id: string | null;
  actor_user_id: string;
  action: string;
  advisory_ref: string | null;
  previous_value: unknown;
  new_value: unknown;
  authorised_by: unknown;
  created_at: Date;
}

function mapPlatformAuditRow(row: PlatformAuditRow): PlatformAuditEntry {
  return {
    id: row.id,
    accountId: row.account_id,
    actorUserId: row.actor_user_id,
    action: row.action,
    advisoryRef: row.advisory_ref,
    previousValue: row.previous_value,
    newValue: row.new_value,
    authorisedBy: row.authorised_by,
    createdAt: row.created_at,
  };
}

/**
 * `ctx.principal` is the AUTHENTICATED caller's own user id, never a
 * value taken from request input -- the same discipline
 * `WriteFeatureFlipContext`/`writeDialSetting` use, and the same one D#7
 * DP3's own Spec text names for `receipt_writer`'s `writeReceipt()`:
 * "derives `actor` from the authenticated session and ignores any
 * `actor` supplied by the caller." `WritePlatformAuditInput` has no
 * `actorUserId` field for the same reason `WriteFeatureFlipInput` has no
 * `decidedByUserId` field.
 *
 * `pool` MUST be connected (or, for a `PoolClient`, have had `SET ROLE`
 * issued) as `exposure_writer` -- `app_user` holds no grant on this
 * table at all, and `platform_ops` holds SELECT only, not INSERT (R1
 * criterion 5). See `WriteFeatureFlipContext` in `exposure.ts` for why
 * this accepts a `PoolClient` as well as a `Pool`.
 */
export interface WritePlatformAuditContext {
  pool: Pool | PoolClient;
  principal: string;
}

export interface WritePlatformAuditInput {
  accountId?: string | null;
  action: string;
  advisoryRef?: string | null;
  previousValue?: unknown;
  newValue?: unknown;
  authorisedBy?: unknown;
}

/**
 * Appends one platform_audit row. `accountId` is nullable -- this is the
 * whole point of the table (R1 criterion 5): a platform-wide action (no
 * single account) writes `accountId: null` or omits it, something
 * `audit_log` cannot represent at all. No UPDATE/DELETE helper exists:
 * no role holds either privilege on this table (R1 criterion 5), so
 * there is nothing for one to call.
 *
 * Deliberately no `RETURNING` clause: `exposure_writer` holds INSERT and
 * NOTHING else on this table (R1 criterion 5's exact matrix -- unlike
 * `account_features`, which grants exposure_writer SELECT too, precisely
 * so `exposure.ts`'s own `RETURNING` can work). `INSERT ... RETURNING`
 * requires the SELECT privilege on the returned columns even when the
 * applicable RLS policy is `USING (true)` -- verified empirically against
 * a throwaway cluster before relying on this (`permission denied for
 * table`, not a filtered/empty result). `id` and `createdAt` are
 * therefore generated here and inserted explicitly, so this function
 * never needs to read back what it just wrote.
 */
export async function writePlatformAudit(
  ctx: WritePlatformAuditContext,
  input: WritePlatformAuditInput,
): Promise<PlatformAuditEntry> {
  const { pool, principal } = ctx;
  const id = randomUUID();
  const createdAt = new Date();

  await pool.query(
    `INSERT INTO platform_audit
       (id, account_id, actor_user_id, action, advisory_ref, previous_value, new_value, authorised_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      input.accountId ?? null,
      principal,
      input.action,
      input.advisoryRef ?? null,
      input.previousValue !== undefined ? JSON.stringify(input.previousValue) : null,
      input.newValue !== undefined ? JSON.stringify(input.newValue) : null,
      input.authorisedBy !== undefined ? JSON.stringify(input.authorisedBy) : null,
      createdAt,
    ],
  );

  return {
    id,
    accountId: input.accountId ?? null,
    actorUserId: principal,
    action: input.action,
    advisoryRef: input.advisoryRef ?? null,
    previousValue: input.previousValue ?? null,
    newValue: input.newValue ?? null,
    authorisedBy: input.authorisedBy ?? null,
    createdAt,
  };
}

/**
 * A read over platform_audit, newest first. `client` must be connected
 * as `platform_ops` (the only role with SELECT on this table -- R1
 * criterion 5) or an admin/migration-owner connection; `app_user` cannot
 * reach this at all. Accepts a `Pool` or a `PoolClient` (see
 * `WritePlatformAuditContext` above for why).
 */
export async function listPlatformAudit(
  client: Pool | PoolClient,
  limit = 100,
): Promise<PlatformAuditEntry[]> {
  const { rows } = await client.query<PlatformAuditRow>(
    `SELECT * FROM platform_audit ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return rows.map(mapPlatformAuditRow);
}
