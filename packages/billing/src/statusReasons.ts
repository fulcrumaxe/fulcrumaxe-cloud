import type { PlanId } from '@fx/spend';
import { withPlatformOps } from './pg.js';
import { authorizeAccountRead } from './authorize.js';
import type { AccountStatus } from './accountStatus.js';
import type { BillingCtx } from './types.js';

/**
 * D#69 B18 (as amended by C1 and C2): the customer-facing copy for an
 * account's billing standing. Pure: `accountStatusReasons` turns facts into
 * every reason that applies, in precedence order, and never exposes an
 * internal state name in a message.
 */
export type StatusReasonAction =
  | 'none'
  | 'keep_plan_portal'
  | 'see_plans'
  | 'update_payment_portal'
  | 'resume'
  | 'contact_support'
  | 'reconnect_key'
  | 'choose_plan';

export type StatusReasonCode =
  | 'cancelled'
  | 'unpaid'
  | 'unsubscribed'
  | 'platform_hold'
  | 'partner_suspended'
  | 'owner_paused'
  | 'past_due'
  | 'key_broken'
  | 'period_end';

export interface StatusReason {
  code: StatusReasonCode;
  message: string;
  action: StatusReasonAction;
}

/** What the copy is derived from: the account's marker columns and its stored subscription standing. */
export interface AccountBillingFacts {
  plan: PlanId;
  /** A Stripe customer has been linked to the account. */
  hasStripeCustomer: boolean;
  /** The fetched Stripe subscription status last stored, or null. */
  stripeSubscriptionStatus: string | null;
  stripeCancelAtPeriodEnd: boolean;
  stripeCurrentPeriodEnd: Date | null;
  subscriptionEndedAt: Date | null;
  pastDueSince: Date | null;
  ownerPausedAt: Date | null;
  partnerSuspendedAt: Date | null;
  platformHoldAt: Date | null;
  keyBrokenAt: Date | null;
  /** `partners.name` of the account's reseller, when there is one. */
  partnerName: string | null;
  /** The clock the grace period is judged against (the database's `now()`). */
  now: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Owner decision 18504921: 7 days of grace after the first failed payment. */
const GRACE_MS = 7 * DAY_MS;
/** Owner decision 18504921: a cancelled account's data is kept this long, then deleted. */
const RETENTION_MS = 30 * DAY_MS;

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);
const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Every active reason, in precedence order: cancelled (or unpaid), then
 * unsubscribed, platform hold, partner suspension, owner pause, past_due,
 * broken key, and last the period-end notice. `cancelled` sorts first
 * because it is the only terminal state (C2b, option A).
 */
export function accountStatusReasons(facts: AccountBillingFacts): StatusReason[] {
  const reasons: StatusReason[] = [];
  const graceExpiredAt =
    facts.pastDueSince !== null && facts.now.getTime() - facts.pastDueSince.getTime() >= GRACE_MS
      ? new Date(facts.pastDueSince.getTime() + GRACE_MS)
      : null;
  const ended = facts.subscriptionEndedAt !== null || graceExpiredAt !== null;

  if (facts.stripeSubscriptionStatus === 'unpaid' && ended) {
    // Row 10 replaces row 9 for an unpaid subscription.
    reasons.push({
      code: 'unpaid',
      message: 'Your payments failed and your subscription is suspended. Update your payment method to restore it.',
      action: 'update_payment_portal',
    });
  } else if (ended) {
    // The purge keys on the earlier of the two ends, so the date shown is that one.
    const ends = [facts.subscriptionEndedAt, graceExpiredAt].filter((d): d is Date => d !== null);
    const purgeOn = new Date(Math.min(...ends.map((d) => d.getTime())) + RETENTION_MS);
    reasons.push({
      code: 'cancelled',
      message: `Your subscription has ended. Your repos, runs and settings are saved until ${isoDate(purgeOn)}, then permanently deleted.`,
      action: 'choose_plan',
    });
  }

  if (!facts.hasStripeCustomer && !ended) {
    reasons.push({ code: 'unsubscribed', message: 'Choose a plan to start running agents.', action: 'see_plans' });
  }
  if (facts.platformHoldAt !== null) {
    reasons.push({
      code: 'platform_hold',
      message: 'Our support team has suspended this account. Agents are stopped. Contact support to restore it.',
      action: 'contact_support',
    });
  }
  if (facts.partnerSuspendedAt !== null) {
    const partner = facts.partnerName ?? 'Your reseller';
    reasons.push({
      code: 'partner_suspended',
      message: `${partner} has suspended this account. Agents are stopped. Contact ${partner} to restore it.`,
      action: 'none',
    });
  }
  if (facts.ownerPausedAt !== null) {
    reasons.push({
      code: 'owner_paused',
      message: `You paused this account on ${isoDate(facts.ownerPausedAt)}. No agents will run until you resume it.`,
      action: 'resume',
    });
  }
  if (facts.pastDueSince !== null && graceExpiredAt === null) {
    // C3c: runs continue through the 7-day grace, so the copy names the day they stop.
    const runsUntil = new Date(facts.pastDueSince.getTime() + GRACE_MS);
    reasons.push({
      code: 'past_due',
      message: `Your last payment failed. Agents keep running until ${isoDate(runsUntil)}. Update your payment method before then to avoid an interruption.`,
      action: 'update_payment_portal',
    });
  }
  if (facts.keyBrokenAt !== null) {
    reasons.push({
      code: 'key_broken',
      message: 'Your model API key stopped working. Agents are stopped until you reconnect it.',
      action: 'reconnect_key',
    });
  }
  if (facts.stripeCancelAtPeriodEnd && !ended) {
    const plan = capitalize(facts.plan);
    reasons.push({
      code: 'period_end',
      message: facts.stripeCurrentPeriodEnd
        ? `Your ${plan} plan ends on ${isoDate(facts.stripeCurrentPeriodEnd)}. Agents keep running until then.`
        : `Your ${plan} plan ends at the end of the current billing period. Agents keep running until then.`,
      action: 'keep_plan_portal',
    });
  }
  return reasons;
}

export interface ReadAccountBillingSummaryInput {
  accountId: string;
}

export interface AccountBillingSummary {
  status: AccountStatus;
  plan: PlanId;
  reasons: StatusReason[];
}

interface SummaryRow {
  status: AccountStatus;
  plan: PlanId;
  has_customer: boolean;
  stripe_subscription_status: string | null;
  stripe_cancel_at_period_end: boolean;
  stripe_current_period_end: Date | null;
  subscription_ended_at: Date | null;
  past_due_since: Date | null;
  owner_paused_at: Date | null;
  partner_suspended_at: Date | null;
  platform_hold_at: Date | null;
  key_broken_at: Date | null;
  partner_name: string | null;
  now: Date;
}

/**
 * Member-tier read (C7): any real member of the account. A non-member
 * (including a cross-tenant principal) gets `null`, the same shape as
 * `readAccountStatus`.
 */
export async function readAccountBillingSummary(
  ctx: BillingCtx,
  input: ReadAccountBillingSummaryInput,
): Promise<AccountBillingSummary | null> {
  const authorized = await authorizeAccountRead(ctx, input.accountId);
  if (!authorized) return null;
  return withPlatformOps(ctx.pool, async (client) => {
    const { rows } = await client.query<SummaryRow>(
      `SELECT a.status, a.plan, a.stripe_customer_id IS NOT NULL AS has_customer,
              a.stripe_subscription_status, a.stripe_cancel_at_period_end, a.stripe_current_period_end,
              a.subscription_ended_at, a.past_due_since, a.owner_paused_at, a.partner_suspended_at,
              a.platform_hold_at, a.key_broken_at, p.name AS partner_name, now() AS now
         FROM accounts a LEFT JOIN partners p ON p.id = a.partner_id
        WHERE a.id = $1 AND a.deleted_at IS NULL`,
      [input.accountId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      status: r.status,
      plan: r.plan,
      reasons: accountStatusReasons({
        plan: r.plan,
        hasStripeCustomer: r.has_customer,
        stripeSubscriptionStatus: r.stripe_subscription_status,
        stripeCancelAtPeriodEnd: r.stripe_cancel_at_period_end,
        stripeCurrentPeriodEnd: r.stripe_current_period_end,
        subscriptionEndedAt: r.subscription_ended_at,
        pastDueSince: r.past_due_since,
        ownerPausedAt: r.owner_paused_at,
        partnerSuspendedAt: r.partner_suspended_at,
        platformHoldAt: r.platform_hold_at,
        keyBrokenAt: r.key_broken_at,
        partnerName: r.partner_name,
        now: r.now,
      }),
    };
  });
}
