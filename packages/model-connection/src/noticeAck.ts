import type { Pool, PoolClient } from 'pg';
import { withTenant } from '@fx/db/src/withTenant.js';
import { getMemberRole, requireOwnerOrAdmin } from '@fx/core/src/tenancy/authorize.js';
import { assertPlanPathKind, NOTICE_VERSIONS, type PlanPathKind } from './planKinds.js';
import type { Principal } from './types.js';

/**
 * D#221 KS part 1: the recorded customer acknowledgement of the plan-path notice. Only an owner or admin may record
 * one (the same rule as saving a connection), the time is the server's clock, the row is insert-only, and RLS keeps
 * it inside the caller's account. The connection id may be pre-allocated: the notice is acknowledged BEFORE the
 * connection is saved, so there is deliberately no foreign key to model_connections.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface NoticeAckCtx {
  pool: Pool;
  principal: Principal;
}

export interface NoticeAckView {
  connection_id: string;
  kind: PlanPathKind;
  notice_version: string;
  acknowledged_at: Date;
}

function assertConnectionId(connectionId: string): void {
  if (typeof connectionId !== 'string' || !UUID_RE.test(connectionId)) {
    throw new TypeError('notice acknowledgement: connectionId must be a UUID');
  }
}

/** Records (once) the acknowledgement of the CURRENT notice version for this connection and kind. Idempotent. */
export async function recordAcknowledgement(
  ctx: NoticeAckCtx,
  params: { connectionId: string; kind: string },
): Promise<NoticeAckView> {
  assertPlanPathKind(params.kind);
  assertConnectionId(params.connectionId);
  const kind = params.kind;
  const { accountId, userId } = ctx.principal;
  requireOwnerOrAdmin(await getMemberRole(ctx.pool, accountId, userId));
  const version = NOTICE_VERSIONS[kind];
  return withTenant(ctx.pool, accountId, userId, async (client) => {
    await client.query(
      `INSERT INTO plan_notice_acks (account_id, connection_id, kind, notice_version, acknowledged_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (account_id, connection_id, kind, notice_version) DO NOTHING`,
      [accountId, params.connectionId, kind, version, userId],
    );
    const { rows } = await client.query<{ acknowledged_at: Date }>(
      `SELECT acknowledged_at FROM plan_notice_acks
        WHERE account_id = $1 AND connection_id = $2 AND kind = $3 AND notice_version = $4`,
      [accountId, params.connectionId, kind, version],
    );
    return { connection_id: params.connectionId, kind, notice_version: version, acknowledged_at: rows[0]!.acknowledged_at };
  });
}

/**
 * True only when an acknowledgement of the CURRENT notice version exists for this connection and kind, in the
 * client's tenant. An unknown kind, a malformed id, or an acknowledgement of an older version is false. For admit,
 * inside its own tenant transaction.
 */
export async function hasAcknowledgementWithClient(
  client: PoolClient,
  connectionId: string,
  kind: string,
): Promise<boolean> {
  if (typeof connectionId !== 'string' || !UUID_RE.test(connectionId)) return false;
  if (kind !== 'codex_access_token' && kind !== 'chatgpt_oauth') return false;
  const { rows } = await client.query(
    `SELECT 1 FROM plan_notice_acks
      WHERE account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
        AND connection_id = $1 AND kind = $2 AND notice_version = $3`,
    [connectionId, kind, NOTICE_VERSIONS[kind]],
  );
  return rows.length > 0;
}

/** Same check, opening its own tenant transaction for `accountId`. */
export function hasAcknowledgement(pool: Pool, accountId: string, connectionId: string, kind: string): Promise<boolean> {
  return withTenant(pool, accountId, (client) => hasAcknowledgementWithClient(client, connectionId, kind));
}
