import type { PoolClient } from 'pg';
import { isPlanId, type PlanId } from '@fx/spend';
import { withPlatformOps } from './pg.js';
import { authorizeAccountRead } from './authorize.js';
import type { BillingCtx } from './types.js';

/**
 * sec-criteria A8: "State machines belong to the tasks that own them
 * (... H10 accounts.plan)." `plan` has no DB CHECK at all (deliberately,
 * so H10 could define that vocabulary without a migration -- see
 * 0001_core.sql's file header). This module is that one place: the legal
 * values for `plan` (read from the plan data through @fx/spend, the single
 * source of truth -- never redeclared here), and the legality rules `pause`/
 * `resume` still need at the app layer.
 *
 * D#69 (migration 0606): `status` itself is no longer written directly --
 * it is derived in the database from a set of marker columns
 * (accounts.past_due_since/owner_paused_at/partner_suspended_at/
 * platform_hold_at/key_broken_at) by the accounts_derive_status trigger.
 * `checkout_completed`/`invoice_paid`/`invoice_payment_failed` used to be
 * `StatusEvent` members whose return value this module's caller wrote
 * straight into `status`; they are gone from that type because there is
 * nothing left for them to gate -- every one of those three is
 * unconditionally legal (accountLifecycle.ts writes the corresponding
 * marker unconditionally; see 0606's own header comment for the current
 * derivation priority, hold > partner > owner pause > key > past_due, so
 * a manual pause now outranks `past_due`, not the other way around).
 * `pause` and `resume` keep a real legality check: which marker to touch
 * depends on the account's CURRENT derived status, and an illegal
 * transition must still be refused rather than silently accepted
 * (sec-criteria A8).
 */
export type AccountStatus = 'unsubscribed' | 'active' | 'past_due' | 'paused' | 'model_key_broken' | 'cancelled';
export type { PlanId as AccountPlan } from '@fx/spend';

/** Read from the plan data on each call (no load-time constant), so a missing setting is the "unavailable" state (PlanDataMissingError), not a crash at import. */
export function isLegalPlan(value: string): value is PlanId {
  return isPlanId(value);
}

export type StatusEvent = 'pause' | 'resume';

/**
 * Returns the next status for `current` under `event`, or `null` when
 * the transition is illegal (sec-criteria A8: "tests that an illegal
 * transition is refused"). `null` means "refuse and do not write" --
 * callers must not fall back to writing `current` unchanged. The
 * returned value is used only to gate the write (accountLifecycle.ts
 * clears/sets the relevant marker column, never `status` itself).
 */
export function nextAccountStatus(current: AccountStatus, event: StatusEvent): AccountStatus | null {
  switch (event) {
    case 'pause':
      // Idempotent: pausing an already-paused account is a no-op, not
      // an error. Refused from model_key_broken (a different
      // subsystem's state, not billing's to overwrite).
      //
      // Security review fix round 2 (D#69 PR-A, MUST-fix 2, CWE-863):
      // pause is now ALSO legal from past_due -- the old refusal here
      // dated from when `status` was a single column and a pause could
      // launder a past_due account back to `active` (resume forced
      // `active` unconditionally). That's no longer how resume works
      // (see below): it only ever clears owner_paused_at and lets
      // whatever's actually underneath derive, so pausing during the
      // 7-day grace window can no longer be used to escape a real
      // payment failure. Refusing it here instead left an owner with NO
      // way to stop runs while past_due -- exactly the gap the security
      // review's probe reproduced (a signed `invoice.payment_failed`
      // left a paused account runnable, and past_due itself couldn't be
      // paused at all).
      if (current === 'model_key_broken') return null;
      return 'paused';
    case 'resume':
      // Only a paused account can be resumed. D#69: the write no longer
      // forces `active` -- it clears owner_paused_at and lets whatever
      // derives underneath (an outstanding past_due, or active) stand.
      return current === 'paused' ? 'active' : null;
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

/** Thrown by service functions when `nextAccountStatus` refuses a transition. */
export class IllegalStatusTransitionError extends Error {
  constructor(current: AccountStatus, event: StatusEvent) {
    super(`illegal account status transition: ${current} -> ${event}`);
    this.name = 'IllegalStatusTransitionError';
  }
}

/**
 * Reads the current status of one account, for callers that need to
 * decide a transition before writing it. Must run inside a
 * platform_ops transaction (see src/pg.ts's withPlatformOps) -- this
 * function issues a plain SELECT with no RLS-scoping GUC, matching
 * platform_ops's unconditional policy.
 *
 * Internal, client-based helper: used from inside an already-open
 * platform_ops transaction (accountLifecycle.ts's own writes, and the
 * webhook's applyStatusEvent) that must not open a second, unrelated
 * transaction of its own. Not part of C7's ctx/input surface -- see
 * `readAccountStatus` below for the public, authorized read.
 *
 * `options.forUpdate` (security-review fix round 3, PR #53, MUST 2):
 * every caller that reads this status in order to decide and then WRITE
 * a transition -- the webhook's `applyStatusEvent`, `pauseAccount`,
 * `resumeAccount` -- passes `{ forUpdate: true }` so the read takes a
 * `SELECT ... FOR UPDATE` row lock, serializing concurrent transitions on
 * the same account one at a time for the rest of the transaction. Without
 * it, two transitions racing on the same account (e.g. a webhook status
 * event and a manual pause) can each read the same stale `current` value
 * and each compute a `next` from it, so the later UPDATE silently
 * overwrites the earlier one's effect instead of being ordered after it
 * (probe R1). The plain, unlocked read stays the default for
 * `readAccountStatus`'s reporting-only call below, which never writes.
 */
export async function readAccountStatusInTx(
  client: PoolClient,
  accountId: string,
  options?: { forUpdate?: boolean },
): Promise<AccountStatus | null> {
  const { rows } = await client.query<{ status: AccountStatus }>(
    `SELECT status FROM accounts WHERE id = $1 AND deleted_at IS NULL${options?.forUpdate ? ' FOR UPDATE' : ''}`,
    [accountId],
  );
  return rows[0]?.status ?? null;
}

export interface ReadAccountStatusInput {
  accountId: string;
}

/**
 * C7 (D#2 comment 18494573, "the H10 note"): the public "plan/status
 * reads" half -- `readAccountStatus(ctx, input)`, D#31 API-7's own wrapping
 * shape. Authorization is member-tier (any real membership on the
 * account qualifies, per C7's "member for status reads"); a principal
 * with no membership on `input.accountId` at all -- including a cross-
 * tenant principal -- gets `null`, the same "not found" a real caller
 * sees for a nonexistent account, never a distinguishable 403.
 */
export async function readAccountStatus(ctx: BillingCtx, input: ReadAccountStatusInput): Promise<AccountStatus | null> {
  const authorized = await authorizeAccountRead(ctx, input.accountId);
  if (!authorized) return null;
  return withPlatformOps(ctx.pool, (client) => readAccountStatusInTx(client, input.accountId));
}
