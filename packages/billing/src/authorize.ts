import type { PoolClient } from 'pg';
import { getMemberRole, requireOwnerOrAdmin, type MembershipRole } from '@fx/core/src/tenancy/authorize.js';
import type { BillingCtx } from './types.js';

/**
 * C7 (D#2 comment 18494573): every ctx-taking H10 write authorizes from
 * `ctx.principal` before touching `accounts`. `@fx/core/src/tenancy/
 * authorize.ts`'s own doc comment names H10 by name as one of the four
 * adopters of `requireOwnerOrAdmin` ("H05 (caps), H10 (billing) and H12
 * ... each ... call this exact function rather than re-deriving the
 * rule") -- this is that call site, shared across every H10 write so the
 * rule lives in exactly one place.
 *
 * Two distinct outcomes, matching H21's own convention
 * (packages/model-connection/src/remove.ts) and the platform-wide
 * NotFoundError doc comment (@fx/core/src/tenancy/errors.ts): a caller
 * with NO membership row on `accountId` at all -- including a principal
 * whose own account is a different one entirely -- gets exactly the same
 * `account_not_found` LifecycleResult billing already returns for a
 * truly nonexistent/already-closed account (RLS-parity: "wrong tenant" and
 * "doesn't exist" must be indistinguishable to the caller, never a 403
 * that confirms the account exists). A real member whose role is below
 * owner/admin throws ForbiddenError via `requireOwnerOrAdmin`, exactly as
 * H21's connect()/remove() do -- an authenticated, tenant-scoped caller
 * missing the required role is a 403, not a 404.
 *
 * Checked before the caller opens its own withPlatformOps transaction
 * (same reasoning as remove.ts's own comment): getMemberRole opens and
 * closes its own transaction, so nesting this inside would hold two
 * connections from `ctx.pool` open for no reason.
 *
 * Returns `null` when authorized (proceed); returns a LifecycleResult-
 * shaped not-found outcome otherwise. The return type is intentionally
 * duck-typed to `{ ok: false; reason: 'account_not_found' }` so it is
 * directly returnable from any of billing's Result-shaped write
 * functions (`LifecycleResult`, `BillingPortalResult`) without a cast.
 */
export async function authorizeAccountWrite(
  ctx: BillingCtx,
  accountId: string,
): Promise<{ ok: false; reason: 'account_not_found' } | null> {
  const role = await getMemberRole(ctx.pool, accountId, ctx.principal.userId);
  if (role === null) {
    return { ok: false, reason: 'account_not_found' };
  }
  requireOwnerOrAdmin(role);
  return null;
}

/**
 * The read-side counterpart: "member for status reads" (C7). Any real
 * membership row -- owner, admin, or member -- qualifies; only a caller
 * with no membership at all is refused, and (matching authorizeAccountWrite)
 * that is reported as not-found rather than forbidden.
 */
export async function authorizeAccountRead(ctx: BillingCtx, accountId: string): Promise<boolean> {
  const role = await getMemberRole(ctx.pool, accountId, ctx.principal.userId);
  return role !== null;
}

/**
 * Security-review fix round 2 (PR #53, finding #4, CWE-367): the
 * TOCTOU-safe sibling of `authorizeAccountWrite`, for the three services
 * that actually write `accounts` (pause/resume/close). `authorizeAccountWrite`
 * checks the role in its OWN transaction, then the caller opens a SECOND,
 * independent transaction for the write -- the review's own probe (P6)
 * demonstrated that a membership row removed and committed in the gap
 * between those two transactions does not stop the write from landing.
 *
 * This closes that gap by reading `account_members` with `FOR SHARE`
 * using the SAME `client` (and therefore the same transaction) the write
 * itself runs in. A `SELECT ... FOR SHARE` takes a shared row lock that
 * is held until the transaction commits or rolls back, so a concurrent
 * `DELETE`/`UPDATE` of that exact row blocks until this transaction
 * finishes -- the removal is serialized after the write, never
 * interleaved with it. Must be called with a `client` that is already
 * inside an open transaction (i.e. from within `withPlatformOps`'s
 * callback), never with a bare pooled connection.
 */
export async function authorizeAccountWriteInTx(
  client: PoolClient,
  accountId: string,
  userId: string,
): Promise<{ ok: false; reason: 'account_not_found' } | null> {
  const { rows } = await client.query<{ role: MembershipRole }>(
    'SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2 FOR SHARE',
    [accountId, userId],
  );
  const role = rows[0]?.role ?? null;
  if (role === null) {
    return { ok: false, reason: 'account_not_found' };
  }
  requireOwnerOrAdmin(role);
  return null;
}
