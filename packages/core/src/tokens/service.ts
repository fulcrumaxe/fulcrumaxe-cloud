import type { Pool, PoolClient } from 'pg';
import { withTenant } from '../tenancy/withTenant.js';
import { AccountNotActiveError, ForbiddenError } from '../tenancy/errors.js';
import { emitDomainEvent } from '../domain-events/emit.js';

/** Local copy of packages/api/src/registry.ts's Scope (C7: every domain module keeps its own copy rather than sharing one type). */
export type Scope = 'read' | 'runs:cancel' | 'audit:read' | 'work_items:write' | 'discussions:write' | 'corrections:write';
export type MembershipRole = 'owner' | 'admin' | 'member';

/**
 * Exported (not just a local const) so tenancy/membership.ts (D#31 C13d,
 * API-3e) can determine "is this a demotion" against the SAME rank table
 * scopes are gated against here, rather than a second copy that could
 * drift. This is a value export, not the `Scope`/`MembershipRole` TYPE
 * duplication C7 asks every domain module to keep its own copy of --
 * membership.ts and this file are both inside @fx/core, so importing the
 * one ranking is a same-package dependency, not the cross-package
 * coupling C7 is about.
 */
export const ROLE_RANK: Record<MembershipRole, number> = { member: 0, admin: 1, owner: 2 };

/** Minimum role per mintable scope. Reserved scopes never reach this map -- routes/tokens.ts's zod schema only accepts these keys. */
const SCOPE_MIN_ROLE: Record<Scope, MembershipRole> = {
  read: 'member',
  'runs:cancel': 'member',
  'audit:read': 'admin',
  'work_items:write': 'admin',
  'discussions:write': 'member',
  'corrections:write': 'member',
};

const DEFAULT_EXPIRES_IN_DAYS = 90;

/** Criterion 8: "A member requesting audit:read -> 403 insufficient_role." */
export function assertScopesAllowedForRole(scopes: readonly Scope[], role: MembershipRole): void {
  for (const scope of scopes) {
    if (ROLE_RANK[role] < ROLE_RANK[SCOPE_MIN_ROLE[scope]]) {
      throw new ForbiddenError(`scope ${scope} requires role >= ${SCOPE_MIN_ROLE[scope]}, got ${role}`);
    }
  }
}

/** Criterion 8: omitted -> 90 days. The 1..365 range is already zod-validated by routes/tokens.ts. */
export function expiresAtFromDays(expiresInDays: number | undefined): Date {
  const days = expiresInDays ?? DEFAULT_EXPIRES_IN_DAYS;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

export interface InsertApiTokenParams {
  accountId: string;
  createdBy: string;
  tokenHash: string;
  displayHint: string;
  /** Optional, immutable label (D#31 C20). Display text only -- never read by any auth, scope, revocation or RLS path, never written to audit. */
  name?: string | null;
  scopes: Scope[];
  expiresAt: Date;
}

export interface InsertedApiToken {
  id: string;
  createdAt: string;
}

/**
 * The pure DB write -- routes/tokens.ts generates the plaintext, hash
 * and display_hint before calling this. Checks live accounts.status
 * (not account_is_active(), which is deleted_at-only) inside the SAME
 * transaction as the INSERT: "minting a token needs an active account"
 * (resolved disagreement 7). Throws AccountNotActiveError -> 409.
 *
 * D#31 C15(a) (follow-up from the #158 review, CWE-367): also locks the
 * MINTING member's own account_members row `FOR SHARE` and re-checks
 * `params.scopes` against that row's role, both inside this same
 * transaction -- not the (possibly stale) role routes/tokens.ts resolved
 * from the session principal at request start. Without this, a mint whose
 * principal was resolved as owner before a concurrent demotion commits
 * still inserted its token afterwards, since neither this function nor
 * the demotion path re-validated it: the demotion's own
 * revokeTokensForCreatorChange only revokes tokens that already exist at
 * the moment it runs, so a token inserted after that pass leaked through.
 *
 * `FOR SHARE` (not `FOR UPDATE`) because this only needs to block a
 * concurrent WRITER (setMemberRole's UPDATE / removeMember's DELETE) on
 * this row, never another concurrent mint -- two mints by the same member
 * both taking a shared lock is fine, they don't conflict with each other.
 * Holding the lock for the rest of this transaction forces the mint and a
 * concurrent demotion/removal to serialise one of two ways: either the
 * demotion/removal commits first (the lock waits for it), and this
 * function's re-read then sees the NEW role and throws ForbiddenError; or
 * this transaction is first (it holds the lock), and the demotion/removal
 * blocks until this COMMIT, after which its own revocation pass runs
 * against a token that, by then, already exists in the table. Either way,
 * no token survives for a creator whose role no longer covers its scopes.
 *
 * The lock is taken through `lock_own_member_role_for_mint()`
 * (migrations/0624), a SECURITY DEFINER function, rather than a raw
 * `SELECT ... FOR SHARE` on `account_members` directly. Postgres checks a
 * locking clause's rows against the applicable policy for the LOCK
 * STRENGTH's own command (UPDATE, for `FOR SHARE`), in addition to the
 * SELECT policy -- and `account_members`' `role_gated_update`
 * (migrations/0005) admits only an owner, or an admin acting on a
 * non-owner row. A plain 'member' minting their own, completely ordinary
 * 'read'-scope token has no UPDATE-policy match on any row, including
 * their own, so a raw `FOR SHARE` issued by `app_user` would silently
 * return zero rows for that (overwhelmingly common) case -- not a
 * permission error, indistinguishable from "not a member" at this layer.
 * The definer function runs as `platform_ops`, whose own `account_members`
 * policy is unconditional, so the lock always succeeds regardless of the
 * calling member's role; it takes no arguments and reads
 * `app.account_id`/`app.user_id` itself (same shape as
 * `current_member_role()`), so it can only ever lock the CALLING session's
 * own row, never double as a cross-account oracle.
 *
 * Throws ForbiddenError (never AccountNotActiveError -- account status
 * and membership are independent conditions) when the row is missing
 * entirely (the creator is no longer a member at all) or when the current
 * role doesn't cover every requested scope.
 */
export async function insertApiToken(pool: Pool, params: InsertApiTokenParams): Promise<InsertedApiToken> {
  return withTenant(pool, params.accountId, params.createdBy, async (client) => {
    const { rows: statusRows } = await client.query<{ status: string }>(
      'SELECT status FROM accounts WHERE id = $1',
      [params.accountId],
    );
    if (statusRows[0]?.status !== 'active') {
      throw new AccountNotActiveError(`account ${params.accountId} is not active`);
    }

    const { rows: memberRows } = await client.query<{ lock_own_member_role_for_mint: MembershipRole | null }>(
      'SELECT lock_own_member_role_for_mint()',
    );
    const role = memberRows[0]?.lock_own_member_role_for_mint ?? undefined;
    if (!role) {
      throw new ForbiddenError(`${params.createdBy} is not a member of account ${params.accountId}`);
    }
    assertScopesAllowedForRole(params.scopes, role);

    const { rows } = await client.query<{ id: string; created_at: Date }>(
      `INSERT INTO api_tokens (account_id, created_by, token_hash, display_hint, scopes, expires_at, name)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, created_at`,
      [params.accountId, params.createdBy, params.tokenHash, params.displayHint, params.scopes, params.expiresAt, params.name ?? null],
    );
    const row = rows[0]!;
    await client.query('SELECT audit_write_api_tokens($1, $2::jsonb)', [
      'api_token.created',
      JSON.stringify({ token_id: row.id, scopes: params.scopes, expires_at: params.expiresAt.toISOString() }),
    ]);
    // API-5c: a hint that the token list changed. Empty payload, and the id stays in subject_id (never on the wire), so a member's stream reveals nothing of anyone's tokens. Last statement before COMMIT (case-A guard).
    await emitDomainEvent(client, { type: 'api_token.created', accountId: params.accountId, subjectId: row.id, payload: {} });
    return { id: row.id, createdAt: row.created_at.toISOString() };
  });
}

export interface ApiTokenListRow {
  id: string;
  displayHint: string;
  name: string | null;
  scopes: Scope[];
  createdBy: string;
  expiresAt: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface ApiTokenRow {
  id: string;
  display_hint: string;
  name: string | null;
  scopes: Scope[];
  created_by: string;
  expires_at: Date;
  created_at: Date;
  created_at_cursor: string;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

const TOKEN_COLUMNS = `id, display_hint, name, scopes, created_by, expires_at, created_at, last_used_at, revoked_at,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor`;

function toListRow(row: ApiTokenRow): ApiTokenListRow {
  return {
    id: row.id,
    displayHint: row.display_hint,
    name: row.name,
    scopes: row.scopes,
    createdBy: row.created_by,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at ? row.last_used_at.toISOString() : null,
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
  };
}

export interface ListApiTokensInput {
  limit: number;
  cursor?: { createdAt: string; id: string };
}

export interface ListApiTokensResult {
  data: ApiTokenListRow[];
  nextCursor: { createdAt: string; id: string } | null;
}

/** No role branch here: api_tokens's own RLS already scopes to own-tokens (member) vs. all (owner/admin). Same keyset shape as runs/read.ts's listRuns. */
export async function listApiTokens(
  pool: Pool,
  ctx: { accountId: string; userId: string },
  input: ListApiTokensInput,
): Promise<ListApiTokensResult> {
  return withTenant(pool, ctx.accountId, ctx.userId, async (client) => {
    const { rows } = await client.query<ApiTokenRow>(
      `SELECT ${TOKEN_COLUMNS} FROM api_tokens
        WHERE ($1::timestamptz IS NULL OR (created_at, id) < ($1::timestamptz, $2::uuid))
        ORDER BY created_at DESC, id DESC
        LIMIT $3::int`,
      [input.cursor?.createdAt ?? null, input.cursor?.id ?? null, input.limit + 1],
    );
    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    const lastRow = page[page.length - 1];
    return {
      data: page.map(toListRow),
      nextCursor: hasMore && lastRow ? { createdAt: lastRow.created_at_cursor, id: lastRow.id } : null,
    };
  });
}

export type RevokeReason = 'user_requested' | 'creator_demoted' | 'creator_removed';

/**
 * Shared by every revocation path below: one audit_write_api_tokens call per revoked id, then (API-5c) one
 * `api_token.revoked` outbox row per id, all in the caller's transaction. The emits come after every audit
 * write and are the last statements of the shared helper (case-A guard); the payload is the reason only.
 */
async function auditRevocations(client: PoolClient, accountId: string, ids: string[], reason: RevokeReason): Promise<void> {
  for (const id of ids) {
    await client.query('SELECT audit_write_api_tokens($1, $2::jsonb)', [
      'api_token.revoked',
      JSON.stringify({ token_id: id, reason }),
    ]);
  }
  for (const id of ids) {
    await emitDomainEvent(client, { type: 'api_token.revoked', accountId, subjectId: id, payload: { reason } });
  }
}

const TOKEN_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Revokes ONE token. Returns false (never throws) on no match; the route
 * maps false -> 404 (CWE-639 uniform-404). S5: a non-uuid id is rejected
 * here, before `id = $2` (a uuid column) can throw 22P02 -> uncaught 500 --
 * same guard shape as runs/read.ts's getRun.
 */
export async function revokeToken(
  pool: Pool,
  ctx: { accountId: string; userId: string; tokenId?: string },
  targetTokenId: string,
  reason: RevokeReason,
): Promise<boolean> {
  if (!TOKEN_UUID_RE.test(targetTokenId)) return false;
  return withTenant(pool, ctx.accountId, ctx.userId, ctx.tokenId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `UPDATE api_tokens SET revoked_at = now(), revoked_reason = $1
        WHERE id = $2 AND account_id = $3 AND revoked_at IS NULL
        RETURNING id`,
      [reason, targetTokenId, ctx.accountId],
    );
    if (rows.length === 0) return false;
    await auditRevocations(client, ctx.accountId, [targetTokenId], reason);
    return true;
  });
}

/**
 * D#31 C13d (API-3e), criteria 1-5. Revokes every unrevoked token
 * `creatorUserId` created in `accountId`, with `creator_demoted` or
 * `creator_removed`. Takes the CALLER'S OWN transaction `client` -- never
 * opens its own `withTenant` -- so this composes into whatever
 * transaction tenancy/membership.ts's `setMemberRole`/`removeMember`
 * already has open: the token revocation and the role change/removal
 * commit or roll back together (criterion 1/4's injected-failure test).
 *
 * RLS needs no migration for this: `0616_api_tokens.sql`'s
 * `tenant_isolation_update` policy already admits an UPDATE from an
 * owner/admin acting on someone ELSE's token (the `EXISTS (...role IN
 * ('owner','admin'))` branch), and the caller here is always the
 * `actorUserId` that `setMemberRole`/`removeMember` already verified is
 * owner/admin via `requireOwnerOrAdmin` before this ever runs. Only the
 * given account's tokens are touched (`account_id = $2`) -- a creator's
 * tokens in a different account are untouched (criterion 2).
 *
 * `audit_write_api_tokens`'s actor resolves through
 * `current_member_user_id()`, which needs the ACTOR's own
 * `account_members` row to still exist at call time. `removeMember`
 * calls this BEFORE its own `DELETE`, precisely so a self-removal
 * (actor === target, allowed when other owners remain) doesn't delete
 * the actor's row before this function's own audit write needs it.
 */
export async function revokeTokensForCreatorChange(
  client: PoolClient,
  accountId: string,
  creatorUserId: string,
  reason: Extract<RevokeReason, 'creator_demoted' | 'creator_removed'>,
): Promise<number> {
  const { rows } = await client.query<{ id: string }>(
    `UPDATE api_tokens SET revoked_at = now(), revoked_reason = $1
      WHERE account_id = $2 AND created_by = $3 AND revoked_at IS NULL
      RETURNING id`,
    [reason, accountId, creatorUserId],
  );
  await auditRevocations(client, accountId, rows.map((r) => r.id), reason);
  return rows.length;
}

/**
 * revoke-mine: "revokes every token the user created." Returns the count
 * revoked (0 is legitimate).
 */
export async function revokeAllMine(pool: Pool, accountId: string, userId: string): Promise<number> {
  return withTenant(pool, accountId, userId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `UPDATE api_tokens SET revoked_at = now(), revoked_reason = 'user_requested'
        WHERE account_id = $1 AND created_by = $2 AND revoked_at IS NULL
        RETURNING id`,
      [accountId, userId],
    );
    await auditRevocations(client, accountId, rows.map((r) => r.id), 'user_requested');
    return rows.length;
  });
}
