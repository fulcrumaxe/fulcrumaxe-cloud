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
  /**
   * The grace and retention boundaries as the database counts them (calendar-day `interval`s in its session zone). Absent, they are
   * counted in UTC calendar days, which is the same thing for a database running in UTC.
   */
  boundaries?: AccountBillingBoundaries;
}

/** The dates the copy names and the grace decision, taken from the same query that read the facts. */
export interface AccountBillingBoundaries {
  /** `past_due_since + interval '7 days'`, or null. */
  graceEndsAt: Date | null;
  /** `NOT (past_due_since > now() - interval '7 days')`: the database's own grace-expired test. */
  graceExpired: boolean;
  /** `subscription_ended_at + interval '30 days'`, or null. */
  endedPurgeAt: Date | null;
  /** `past_due_since + interval '7 days' + interval '30 days'`, or null. */
  gracePurgeAt: Date | null;
}

/** Owner decision 18504921: 7 days of grace after the first failed payment. */
const GRACE_DAYS = 7;
/** Owner decision 18504921: a cancelled account's data is kept this long, then deleted. */
const RETENTION_DAYS = 30;

const addUtcDays = (d: Date, n: number): Date => {
  const out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() + n);
  return out;
};

/** The boundaries for facts that did not come from the database: calendar days in UTC. */
function utcBoundaries(f: AccountBillingFacts): AccountBillingBoundaries {
  const graceEndsAt = f.pastDueSince === null ? null : addUtcDays(f.pastDueSince, GRACE_DAYS);
  return {
    graceEndsAt,
    graceExpired: graceEndsAt !== null && f.now.getTime() >= graceEndsAt.getTime(),
    endedPurgeAt: f.subscriptionEndedAt === null ? null : addUtcDays(f.subscriptionEndedAt, RETENTION_DAYS),
    gracePurgeAt: graceEndsAt === null ? null : addUtcDays(graceEndsAt, RETENTION_DAYS),
  };
}

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
  const b = facts.boundaries ?? utcBoundaries(facts);
  const graceExpired = b.graceExpired && b.graceEndsAt !== null;
  const ended = facts.subscriptionEndedAt !== null || graceExpired;

  if (facts.stripeSubscriptionStatus === 'unpaid' && ended) {
    // Row 10 replaces row 9 for an unpaid subscription.
    reasons.push({
      code: 'unpaid',
      message: 'Your payments failed and your subscription is suspended. Update your payment method to restore it.',
      action: 'update_payment_portal',
    });
  } else if (ended) {
    // The purge keys on the earlier of the two ends, so the date shown is that one.
    const purges = [facts.subscriptionEndedAt !== null ? b.endedPurgeAt : null, graceExpired ? b.gracePurgeAt : null].filter(
      (d): d is Date => d !== null,
    );
    const purgeOn = new Date(Math.min(...purges.map((d) => d.getTime())));
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
  if (facts.pastDueSince !== null && !graceExpired) {
    // C3c: runs continue through the 7-day grace, so the copy names the day they stop.
    const runsUntil = b.graceEndsAt ?? addUtcDays(facts.pastDueSince, GRACE_DAYS);
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
  grace_ends_at: Date | null;
  grace_expired: boolean;
  ended_purge_at: Date | null;
  grace_purge_at: Date | null;
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
              a.platform_hold_at, a.key_broken_at, p.name AS partner_name, now() AS now,
              a.past_due_since + interval '7 days' AS grace_ends_at,
              COALESCE(NOT (a.past_due_since > now() - interval '7 days'), false) AS grace_expired,
              a.subscription_ended_at + interval '30 days' AS ended_purge_at,
              a.past_due_since + interval '7 days' + interval '30 days' AS grace_purge_at
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
        boundaries: {
          graceEndsAt: r.grace_ends_at,
          graceExpired: r.grace_expired,
          endedPurgeAt: r.ended_purge_at,
          gracePurgeAt: r.grace_purge_at,
        },
      }),
    };
  });
}
