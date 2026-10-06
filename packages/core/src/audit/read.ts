import type { Pool } from 'pg';
import { withTenant } from '../tenancy/withTenant.js';

/** Same local-copy convention as runs/read.ts. */
export interface Principal {
  accountId: string;
  userId: string;
}

/** `(ctx:{pool, principal}, input)` -- packages/api's route handler wraps this directly. */
export interface AuditReadCtx {
  /** app_user pool: the read goes through withTenant/RLS, so another account's rows are invisible. */
  pool: Pool;
  principal: Principal;
}

export const AUDIT_DEFAULT_LIMIT = 50;
export const AUDIT_MAX_LIMIT = 200;

/** D#31 API-7b: one audit row as the API serves it. */
export interface AuditLogItem {
  id: string;
  action: string;
  actor: string | null;
  payload: unknown;
  created_at: string;
}

export interface ListAuditLogInput {
  /** Raw full-precision text of the last row's created_at plus its id, as decoded by the route. */
  cursor?: { createdAt: string; id: string };
  /** Defaults to 50; values above 200 are clamped, below 1 raised to 1. */
  limit?: number;
}

export interface ListAuditLogResult {
  data: AuditLogItem[];
  nextCursor: { createdAt: string; id: string } | null;
}

interface AuditRow {
  id: string;
  action: string;
  actor: string | null;
  payload: unknown;
  created_at: Date;
  created_at_cursor: string;
}

/**
 * Keyset pagination on `(created_at, id)`, newest first, read through the audit_log_read() function (migration 0653). The cursor keeps the
 * timestamp as text so microsecond precision survives (a JS Date would drop it
 * and skip or repeat rows). Payloads are returned exactly as stored: the
 * writers are allowlisted and never put secrets in them, so nothing is redacted here.
 */
export async function listAuditLog(ctx: AuditReadCtx, input: ListAuditLogInput = {}): Promise<ListAuditLogResult> {
  const { accountId, userId } = ctx.principal;
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? AUDIT_DEFAULT_LIMIT), 1), AUDIT_MAX_LIMIT);
  const { cursor } = input;
  return withTenant(ctx.pool, accountId, userId, async (client) => {
    // The database clamps p_limit to 200, so a full-size page cannot fetch its own +1 row.
    const fetch = (n: number, c: { createdAt: string; id: string } | undefined) =>
      client.query<AuditRow>('SELECT * FROM audit_log_read($1::int, $2::text, $3::uuid)', [n, c?.createdAt ?? null, c?.id ?? null]);
    const { rows } = await fetch(limit + 1, cursor);
    let hasMore = rows.length > limit;
    if (!hasMore && rows.length === AUDIT_MAX_LIMIT) {
      const tail = rows[rows.length - 1]!;
      hasMore = (await fetch(1, { createdAt: tail.created_at_cursor, id: tail.id })).rows.length > 0;
    }
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      data: page.map((r) => ({
        id: r.id,
        action: r.action,
        actor: r.actor,
        payload: r.payload,
        created_at: r.created_at.toISOString(),
      })),
      nextCursor: hasMore && last ? { createdAt: last.created_at_cursor, id: last.id } : null,
    };
  });
}
