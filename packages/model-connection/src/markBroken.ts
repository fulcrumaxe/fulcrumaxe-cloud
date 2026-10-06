import type { Pool, PoolClient } from 'pg';
import { withPlatformOps } from '@fx/core/src/tenancy/withPlatformOps.js';
import { emitDomainEvent } from '@fx/core/src/domain-events/emit.js';

/**
 * Criterion 5. Mirrors `packages/runner/src/connectionStatusPort.ts`'s
 * `BrokenConnectionCode` (PR #50, branch `sandbox-orchestration-primitives`,
 * H09a, unmerged as of this PR) -- narrowed to the two statuses the Spec
 * calls markBroken for. 402/`quota_for_entity_exceeded` is a budget
 * problem, not a broken credential, and must never reach this function.
 *
 * Duplicated, not imported: this package can't depend on `@fx/runner`
 * while #50 is unmerged (nor should it in the other direction). Keep in
 * sync with that file's type if it changes; structural typing makes this
 * assignable to the real `ConnectionStatusPort` either way.
 */
export type BrokenConnectionCode = 401 | 403;

/**
 * The `ConnectionStatusPort` shape from PR #50 -- no `pool` parameter,
 * since a real instance is bound once (createConnectionStatusPort below)
 * and handed around as this two-argument interface.
 */
export interface ConnectionStatusPort {
  markBroken(accountId: string, code: BrokenConnectionCode): Promise<void>;
}

/**
 * Sets `model_connections.status = 'broken'` and `accounts.key_broken_at`,
 * which pauses new queued/scheduled work: reserve() denies any
 * non-preview reservation once accounts.status is neither 'active' nor a
 * `past_due` account still inside its 7-day grace window (H05 pass/fail
 * item 5; see the key_broken_at-outranks-past_due note below for why a
 * broken key itself is never read as grace-eligible). Pausing runs
 * already IN FLIGHT and the dashboard/email notification are H09's/H11's
 * jobs.
 *
 * D#31 comment 18494573 (C6-4): "markBroken takes the caller's
 * transaction client, or exposes the one it uses, so a domain event can
 * be emitted in the same transaction." D#31 API-4a criterion 5 makes this
 * concrete: this function itself emits `model_connection.broken` on
 * `client`, in the same transaction as the two UPDATEs below -- a failure
 * injected after the emit (before commit) leaves neither the status
 * change nor the event (see packages/core/test/domain-events.test.ts's
 * rollback test for the underlying guarantee; this function adds no
 * transaction handling of its own, so that guarantee applies here
 * unchanged).
 *
 * D#69 (migration 0606): writes `key_broken_at` instead of `accounts.status`
 * directly -- the accounts_derive_status trigger now rejects a direct
 * status write that doesn't match derivation. Security review finding 2
 * (CWE-841) still holds without the old `WHERE status = 'active'` guard:
 * key_broken_at ranks below every pause marker (platform_hold_at,
 * partner_suspended_at, owner_paused_at) in the derivation priority
 * (migration 0606's own header comment), so setting it never lifts, or is
 * masked incorrectly by, a platform hold, a partner suspension, or an
 * owner pause -- the derived `status` simply keeps showing the more
 * severe marker's state. Security review fix round 2 (MUST-fix 1,
 * CWE-841/863) also moved key_broken_at ABOVE past_due_since: reserve()
 * admits a stored `past_due` within its 7-day grace window, so a broken
 * key must outrank it too, or a payment failure landing after the key
 * broke would silently make the account runnable again.
 */
export async function markBrokenWithClient(
  client: PoolClient,
  accountId: string,
  code: BrokenConnectionCode,
): Promise<void> {
  await client.query(
    `UPDATE model_connections SET status = 'broken', last_error_code = $2 WHERE account_id = $1`,
    [accountId, String(code)],
  );
  await client.query(
    `UPDATE accounts SET key_broken_at = COALESCE(key_broken_at, now()) WHERE id = $1`,
    [accountId],
  );
  await emitDomainEvent(client, {
    type: 'model_connection.broken',
    accountId,
    payload: { code },
  });
}

/** Opens its own platform_ops transaction around markBrokenWithClient -- the simple, single-call case. */
export async function markBroken(
  platformOpsPool: Pool,
  accountId: string,
  code: BrokenConnectionCode,
): Promise<void> {
  await withPlatformOps(platformOpsPool, (client) => markBrokenWithClient(client, accountId, code));
}

/** A real `ConnectionStatusPort`, bound to `platformOpsPool` -- mirrors PR #50's `createTestConnectionStatusPort()` shape. */
export function createConnectionStatusPort(platformOpsPool: Pool): ConnectionStatusPort {
  return {
    markBroken: (accountId: string, code: BrokenConnectionCode): Promise<void> =>
      markBroken(platformOpsPool, accountId, code),
  };
}
