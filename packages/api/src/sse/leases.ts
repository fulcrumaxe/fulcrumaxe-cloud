import type { Pool } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import { isPlanId, planFor, type PlanId } from "@fx/spend";
import { ApiError } from "../errors.js";
import type { MembershipRole } from "../registry.js";

/**
 * D#31 API-5 criterion 5: stream caps and leases.
 *
 * A lease is a `stream_leases` row (migration 0639) that expires 90 s
 * after its last renewal. The renewal is folded into the 60-second
 * principal re-check (criterion 4) as a data-modifying CTE in the SAME
 * statement, so the caps add no query the re-check was not already making
 * -- the "cost-analyst" constraint from the panel. A process killed
 * without releasing its lease frees its slot within 90 s on its own.
 */
export const LEASE_TTL_MS = 90_000;

/** Sessions: "6 streams per user (two per browser, three devices), 25 per account". */
export const SESSION_STREAMS_PER_USER = 6;
export const SESSION_STREAMS_PER_ACCOUNT = 25;

/**
 * Token streams per tenant by plan. The figures are private plan data
 * (`loadPlanData()`), read on each call so a missing setting is the
 * "unavailable" state rather than an import-time crash.
 */
export function tokenStreamsPerTenant(plan: PlanId): number {
  return planFor(plan).tokenStreamsPerTenant;
}

/** The `Retry-After` on a `stream_limit` 429: a hint, not a promise -- a slot frees as soon as any holder disconnects, and at worst 90 s after a killed one. */
export const STREAM_LIMIT_RETRY_AFTER_SECONDS = 30;

/**
 * 429 `stream_limit`. Deliberately NO `retry:` field anywhere: an
 * `EventSource` never parses the body of a non-200 response and cannot
 * see the status, so a `retry:` line would be dead text; external clients
 * get `Retry-After`, and WS-F1's own backoff governs the browser.
 */
export class StreamLimitError extends ApiError {
  constructor(public readonly retryAfterSeconds: number = STREAM_LIMIT_RETRY_AFTER_SECONDS) {
    super(429, "stream_limit", "too many open streams");
  }
}

export type LeaseKind = "session" | "token";

export interface LeaseSubject {
  kind: LeaseKind;
  accountId: string;
  /** The user id for a session, the api_tokens id for a token. */
  principalKey: string;
}

/**
 * Takes a lease or throws `StreamLimitError`. The count-then-insert runs
 * under a per-account advisory lock inside one transaction, so two
 * concurrent opens cannot both see room for one more. Expired leases for
 * the account are swept in the same transaction (cheap: the account's own
 * few rows, on `idx_stream_leases_account_kind`). Every statement runs
 * under `withTenant`, i.e. under `stream_leases`' RLS policy: this can
 * only ever count, sweep or insert THIS account's rows, so one tenant
 * cannot exhaust, see or free another's slots.
 */
export async function acquireLease(pool: Pool, subject: LeaseSubject, nowMs: number): Promise<string> {
  const now = new Date(nowMs);
  const expires = new Date(nowMs + LEASE_TTL_MS);
  const result = await withTenant(pool, subject.accountId, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`stream_lease:${subject.accountId}`]);
    await client.query("DELETE FROM stream_leases WHERE account_id = $1 AND expires_at <= $2", [subject.accountId, now]);
    const { rows } = await client.query<{ mine: number; total: number; plan: string | null }>(
      `SELECT count(*) FILTER (WHERE principal_key = $3)::int AS mine,
              count(*)::int AS total,
              (SELECT plan FROM accounts WHERE id = $1) AS plan
         FROM stream_leases WHERE account_id = $1 AND kind = $2`,
      [subject.accountId, subject.kind, subject.principalKey],
    );
    const row = rows[0]!;
    if (subject.kind === "session") {
      if (row.mine >= SESSION_STREAMS_PER_USER || row.total >= SESSION_STREAMS_PER_ACCOUNT) {
        return { leaseId: null };
      }
    } else {
      if (row.plan === null || !isPlanId(row.plan)) {
        throw new Error(`streams: account ${subject.accountId} has no resolvable plan`);
      }
      if (row.total >= tokenStreamsPerTenant(row.plan as PlanId)) {
        return { leaseId: null };
      }
    }
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO stream_leases (account_id, kind, principal_key, expires_at) VALUES ($1, $2, $3, $4) RETURNING id`,
      [subject.accountId, subject.kind, subject.principalKey, expires],
    );
    return { leaseId: inserted.rows[0]!.id };
  });
  if (!result.leaseId) {
    throw new StreamLimitError();
  }
  return result.leaseId;
}

/** Best-effort: a failed release just leaves the row to expire in <= 90 s. Scoped to the caller's own kind + principal, not merely the lease id. */
export async function releaseLease(pool: Pool, subject: LeaseSubject, leaseId: string): Promise<void> {
  try {
    await withTenant(pool, subject.accountId, async (client) => {
      await client.query(
        "DELETE FROM stream_leases WHERE id = $1 AND account_id = $2 AND kind = $3 AND principal_key = $4",
        [leaseId, subject.accountId, subject.kind, subject.principalKey],
      );
    });
  } catch {
    // Expires on its own.
  }
}

export type RecheckOutcome =
  | { status: "ok"; renewed: boolean; role: MembershipRole }
  | { status: "revoked"; reason: "membership" | "token" };

/**
 * The tenant half of the 60-second re-check for a SESSION principal: is
 * the user still a member of the account -- and, in the same statement,
 * renew the lease. The renewal is a data-modifying CTE guarded by
 * `EXISTS (SELECT 1 FROM m)`, so a removed member's lease is NOT renewed.
 * (The epoch / per-session revocation half is `getSessionEpochAndRevocation`
 * on the platform_ops pool, done by the caller -- exactly the two lookups
 * `resolvePrincipal` already makes.)
 *
 * `leaseId` null means "check only" (JSON mode, and the query-counter
 * test's baseline): same statement minus the renewal.
 */
export async function recheckSessionMembership(
  pool: Pool,
  subject: LeaseSubject,
  leaseId: string | null,
  nowMs: number,
): Promise<RecheckOutcome> {
  const expires = new Date(nowMs + LEASE_TTL_MS);
  const row = await withTenant(pool, subject.accountId, subject.principalKey, async (client) => {
    const { rows } = await client.query<{ role: string | null; renewed: number }>(
      `WITH m AS (SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2),
            l AS (UPDATE stream_leases SET expires_at = $4
                   WHERE id = $3 AND account_id = $1 AND kind = 'session' AND principal_key = $2
                     AND EXISTS (SELECT 1 FROM m)
                  RETURNING 1)
       SELECT (SELECT role FROM m) AS role, (SELECT count(*) FROM l)::int AS renewed`,
      [subject.accountId, subject.principalKey, leaseId, expires],
    );
    return rows[0]!;
  });
  if (row.role === null) {
    return { status: "revoked", reason: "membership" };
  }
  return { status: "ok", renewed: row.renewed > 0, role: row.role as MembershipRole };
}

/**
 * The tenant half of the re-check for a TOKEN principal, in one
 * statement: `resolve_api_token` (the same definer `resolveApiToken`
 * calls -- revocation, expiry, closed account, creator no longer a
 * member) plus the guarded lease renewal. The token must still exist
 * under the same id and account, be unrevoked and unexpired, its creator
 * still a member, and still hold the `read` scope.
 */
export async function recheckToken(
  pool: Pool,
  subject: LeaseSubject,
  tokenHash: string,
  leaseId: string | null,
  nowMs: number,
): Promise<RecheckOutcome> {
  const expires = new Date(nowMs + LEASE_TTL_MS);
  const now = new Date(nowMs);
  const row = await withTenant(pool, subject.accountId, async (client) => {
    const { rows } = await client.query<{ valid: boolean; role: string | null; renewed: number }>(
      `WITH t AS (SELECT * FROM resolve_api_token($1)),
            ok AS (SELECT t.creator_role FROM t
                    WHERE t.id = $2 AND t.account_id = $3 AND t.revoked_at IS NULL
                      AND t.expires_at > $5 AND t.creator_role IS NOT NULL AND 'read' = ANY (t.scopes)),
            l AS (UPDATE stream_leases SET expires_at = $6
                   WHERE id = $4 AND account_id = $3 AND kind = 'token' AND principal_key = $2
                     AND EXISTS (SELECT 1 FROM ok)
                  RETURNING 1)
       SELECT EXISTS (SELECT 1 FROM ok) AS valid, (SELECT creator_role FROM ok) AS role,
              (SELECT count(*) FROM l)::int AS renewed`,
      [tokenHash, subject.principalKey, subject.accountId, leaseId, now, expires],
    );
    return rows[0]!;
  });
  if (!row.valid) {
    return { status: "revoked", reason: "token" };
  }
  return { status: "ok", renewed: row.renewed > 0, role: row.role as MembershipRole };
}
