import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { createPool as createBillingPool } from '../src/pg.js';
import { accountStatusReasons, readAccountBillingSummary, type AccountBillingFacts } from '../src/statusReasons.js';
import { seedAccountWithMember } from './helpers/seed.js';

const NOW = new Date('2026-10-10T12:00:00.000Z');
const day = (n: number): Date => new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000);

/** An active Starter account with nothing wrong; each test switches on the facts it is about. */
const facts = (o: Partial<AccountBillingFacts> = {}): AccountBillingFacts => ({
  plan: 'team',
  hasStripeCustomer: true,
  stripeSubscriptionStatus: 'active',
  stripeCancelAtPeriodEnd: false,
  stripeCurrentPeriodEnd: null,
  subscriptionEndedAt: null,
  pastDueSince: null,
  ownerPausedAt: null,
  partnerSuspendedAt: null,
  platformHoldAt: null,
  keyBrokenAt: null,
  partnerName: null,
  now: NOW,
  ...o,
});

describe('D#69 B18 copy table (pure)', () => {
  it('row 1: active has no reasons', () => {
    expect(accountStatusReasons(facts())).toEqual([]);
  });

  it('row 2: cancel at period end', () => {
    expect(accountStatusReasons(facts({ stripeCancelAtPeriodEnd: true, stripeCurrentPeriodEnd: new Date('2026-11-03T23:59:59Z') }))).toEqual([
      { code: 'period_end', message: 'Your Team plan ends on 2026-11-03. Agents keep running until then.', action: 'keep_plan_portal' },
    ]);
  });

  it('row 2 without a stored period end still renders, with no date', () => {
    const [r] = accountStatusReasons(facts({ plan: 'scale', stripeCancelAtPeriodEnd: true }));
    expect(r!.message).toBe('Your Scale plan ends at the end of the current billing period. Agents keep running until then.');
  });

  it('row 3 (C1): unsubscribed', () => {
    expect(accountStatusReasons(facts({ hasStripeCustomer: false, stripeSubscriptionStatus: null }))).toEqual([
      { code: 'unsubscribed', message: 'Choose a plan to start running agents.', action: 'see_plans' },
    ]);
  });

  it('row 4 (C3c): past_due on day 0 says agents keep running until day 7', () => {
    expect(accountStatusReasons(facts({ pastDueSince: day(0) }))).toEqual([
      {
        code: 'past_due',
        message:
          'Your last payment failed. Agents keep running until 2026-10-17. Update your payment method before then to avoid an interruption.',
        action: 'update_payment_portal',
      },
    ]);
  });

  it('row 4 (C3c): past_due on day 6 still shows row 4, with the date of day 7', () => {
    expect(accountStatusReasons(facts({ pastDueSince: day(-6) }))).toEqual([
      {
        code: 'past_due',
        message:
          'Your last payment failed. Agents keep running until 2026-10-11. Update your payment method before then to avoid an interruption.',
        action: 'update_payment_portal',
      },
    ]);
  });

  it('row 4 gives way at exactly 7 days of past_due (0606: past_due_since > now() - 7 days is the grace)', () => {
    expect(accountStatusReasons(facts({ pastDueSince: day(-7) })).map((r) => r.code)).toEqual(['cancelled']);
    expect(accountStatusReasons(facts({ pastDueSince: day(-7), stripeSubscriptionStatus: 'unpaid' })).map((r) => r.code)).toEqual([
      'unpaid',
    ]);
  });

  it('row 4 gives way on day 8: row 9, or row 10 when the fetched status is unpaid', () => {
    expect(accountStatusReasons(facts({ pastDueSince: day(-8) })).map((r) => r.code)).toEqual(['cancelled']);
    expect(accountStatusReasons(facts({ pastDueSince: day(-8), stripeSubscriptionStatus: 'unpaid' })).map((r) => r.code)).toEqual([
      'unpaid',
    ]);
  });

  it('row 5: owner pause', () => {
    expect(accountStatusReasons(facts({ ownerPausedAt: new Date('2026-10-02T08:00:00Z') }))).toEqual([
      {
        code: 'owner_paused',
        message: 'You paused this account on 2026-10-02. No agents will run until you resume it.',
        action: 'resume',
      },
    ]);
  });

  it('row 6: partner pause names the partner twice, action none', () => {
    expect(accountStatusReasons(facts({ partnerSuspendedAt: day(-1), partnerName: 'Acme Resale' }))).toEqual([
      {
        code: 'partner_suspended',
        message: 'Acme Resale has suspended this account. Agents are stopped. Contact Acme Resale to restore it.',
        action: 'none',
      },
    ]);
  });

  it('row 7: platform hold', () => {
    expect(accountStatusReasons(facts({ platformHoldAt: day(-1) }))).toEqual([
      {
        code: 'platform_hold',
        message: 'Our support team has suspended this account. Agents are stopped. Contact support to restore it.',
        action: 'contact_support',
      },
    ]);
  });

  it('row 8: broken key', () => {
    expect(accountStatusReasons(facts({ keyBrokenAt: day(-1) }))).toEqual([
      {
        code: 'key_broken',
        message: 'Your model API key stopped working. Agents are stopped until you reconnect it.',
        action: 'reconnect_key',
      },
    ]);
  });

  it('row 9 (C2): cancelled names the purge date, 30 days after the subscription ended', () => {
    expect(
      accountStatusReasons(facts({ stripeSubscriptionStatus: 'canceled', subscriptionEndedAt: new Date('2026-10-05T23:30:00Z') })),
    ).toEqual([
      {
        code: 'cancelled',
        message: 'Your subscription has ended. Your repos, runs and settings are saved until 2026-11-04, then permanently deleted.',
        action: 'choose_plan',
      },
    ]);
  });

  it('row 9 also covers an expired grace period: 7 days of grace, then 30', () => {
    const [r] = accountStatusReasons(facts({ pastDueSince: new Date('2026-10-01T00:00:00Z') }));
    expect(r).toEqual({
      code: 'cancelled',
      message: 'Your subscription has ended. Your repos, runs and settings are saved until 2026-11-07, then permanently deleted.',
      action: 'choose_plan',
    });
  });

  it('row 9 shows the earlier of the two ends, the one the purge acts on first', () => {
    const [r] = accountStatusReasons(
      facts({ subscriptionEndedAt: new Date('2026-10-09T00:00:00Z'), pastDueSince: new Date('2026-10-01T00:00:00Z') }),
    );
    expect(r!.message).toContain('until 2026-11-07,');
  });

  it('row 10 (C2): an unpaid subscription replaces row 9 and names no purge date', () => {
    const reasons = accountStatusReasons(facts({ stripeSubscriptionStatus: 'unpaid', subscriptionEndedAt: day(-1) }));
    expect(reasons).toEqual([
      {
        code: 'unpaid',
        message: 'Your payments failed and your subscription is suspended. Update your payment method to restore it.',
        action: 'update_payment_portal',
      },
    ]);
  });

  it('an unpaid subscription replaces row 9 even when the grace period also ran out', () => {
    const reasons = accountStatusReasons(facts({ stripeSubscriptionStatus: 'unpaid', pastDueSince: day(-9) }));
    expect(reasons.map((r) => r.code)).toEqual(['unpaid']);
  });

  it('stacked: owner pause plus past_due lists two reasons, owner pause first', () => {
    const reasons = accountStatusReasons(facts({ ownerPausedAt: day(-1), pastDueSince: day(-2) }));
    expect(reasons.map((r) => r.code)).toEqual(['owner_paused', 'past_due']);
  });

  it('cancelled sorts first (C2b), ahead of every pause and broken-key reason, and the period-end notice is dropped', () => {
    const reasons = accountStatusReasons(
      facts({
        stripeSubscriptionStatus: 'canceled',
        subscriptionEndedAt: day(-1),
        stripeCancelAtPeriodEnd: true,
        stripeCurrentPeriodEnd: day(-1),
        platformHoldAt: day(-1),
        partnerSuspendedAt: day(-1),
        ownerPausedAt: day(-1),
        keyBrokenAt: day(-1),
        partnerName: 'P',
      }),
    );
    expect(reasons.map((r) => r.code)).toEqual(['cancelled', 'platform_hold', 'partner_suspended', 'owner_paused', 'key_broken']);
  });

  it('full precedence with everything but the terminal state', () => {
    const reasons = accountStatusReasons(
      facts({
        hasStripeCustomer: false,
        platformHoldAt: day(-1),
        partnerSuspendedAt: day(-1),
        ownerPausedAt: day(-1),
        pastDueSince: day(-1),
        keyBrokenAt: day(-1),
        stripeCancelAtPeriodEnd: true,
      }),
    );
    expect(reasons.map((r) => r.code)).toEqual([
      'unsubscribed',
      'platform_hold',
      'partner_suspended',
      'owner_paused',
      'past_due',
      'key_broken',
      'period_end',
    ]);
  });

  it('no message contains an internal state name', () => {
    const everything = [
      facts({ hasStripeCustomer: false }),
      facts({ stripeSubscriptionStatus: 'unpaid', subscriptionEndedAt: day(-1) }),
      facts({
        subscriptionEndedAt: day(-1),
        platformHoldAt: day(-1),
        partnerSuspendedAt: day(-1),
        ownerPausedAt: day(-1),
        keyBrokenAt: day(-1),
        stripeCancelAtPeriodEnd: true,
      }),
      facts({
        platformHoldAt: day(-1),
        partnerSuspendedAt: day(-1),
        ownerPausedAt: day(-1),
        pastDueSince: day(-1),
        keyBrokenAt: day(-1),
        stripeCancelAtPeriodEnd: true,
      }),
    ].flatMap((f) => accountStatusReasons(f));
    expect(everything.length).toBeGreaterThan(8);
    for (const r of everything) {
      expect(r.message).not.toMatch(/past_due|model_key_broken|platform_ops|suspended by platform/);
    }
  });
});

describe('D#69 B18 readAccountBillingSummary (real Postgres)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let opsPool: Pool;

  beforeAll(async () => {
    adminPool = createBillingPool(process.env.BILLING_DATABASE_URL!);
    admin = await adminPool.connect();
    opsPool = createBillingPool(process.env.BILLING_DATABASE_URL_PLATFORM_OPS!);
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), opsPool.end()]);
  });

  it('a member reads status, plan and reasons; the partner name comes from partners.name', async () => {
    const t = await seedAccountWithMember(admin, 'member', { status: 'active', plan: 'team' });
    const partnerId = randomUUID();
    await admin.query(`INSERT INTO partners (id, kind, status, name) VALUES ($1, 'reseller', 'active', 'Acme Resale')`, [partnerId]);
    await admin.query(
      `UPDATE accounts SET partner_id = $2, partner_suspended_at = now(), stripe_cancel_at_period_end = true,
              stripe_current_period_end = '2026-12-01T00:00:00Z' WHERE id = $1`,
      [t.accountId, partnerId],
    );
    const summary = await readAccountBillingSummary({ pool: opsPool, principal: t }, { accountId: t.accountId });
    expect(summary).toMatchObject({ status: 'paused', plan: 'team' });
    expect(summary!.reasons.map((r) => r.code)).toEqual(['partner_suspended', 'period_end']);
    expect(summary!.reasons[0]!.message).toBe(
      'Acme Resale has suspended this account. Agents are stopped. Contact Acme Resale to restore it.',
    );
    expect(summary!.reasons[1]!.message).toBe('Your Team plan ends on 2026-12-01. Agents keep running until then.');
  });

  it('a cancelled account reads cancelled with the purge date from the stored end', async () => {
    const t = await seedAccountWithMember(admin, 'owner', { status: 'active' });
    await admin.query(
      `UPDATE accounts SET stripe_subscription_status = 'canceled', subscription_ended_at = '2026-10-05T10:00:00Z' WHERE id = $1`,
      [t.accountId],
    );
    const summary = await readAccountBillingSummary({ pool: opsPool, principal: t }, { accountId: t.accountId });
    expect(summary!.status).toBe('cancelled');
    expect(summary!.reasons).toEqual([
      {
        code: 'cancelled',
        message: 'Your subscription has ended. Your repos, runs and settings are saved until 2026-11-04, then permanently deleted.',
        action: 'choose_plan',
      },
    ]);
  });

  it('a non-member, and a principal from another account, get null', async () => {
    const target = await seedAccountWithMember(admin, 'owner', { status: 'active' });
    const stranger = await seedAccountWithMember(admin, 'owner');
    expect(await readAccountBillingSummary({ pool: opsPool, principal: stranger }, { accountId: target.accountId })).toBeNull();
  });

  it('a closed account reads null even for its own member', async () => {
    const t = await seedAccountWithMember(admin, 'owner', { status: 'active' });
    await admin.query('UPDATE accounts SET deleted_at = now() WHERE id = $1', [t.accountId]);
    expect(await readAccountBillingSummary({ pool: opsPool, principal: t }, { accountId: t.accountId })).toBeNull();
  });
});

/**
 * The database counts the grace and the retention in calendar days in its session zone (`interval '7 days'`), which is 167 or 169
 * hours across a clock change. The copy dates and the grace decision must be the database's own, whatever zone it runs in. The zone is
 * a POSIX rule built from today's date, so the test needs no zone database and does not depend on the host's TZ.
 */
describe('billing boundaries across a clock change (real Postgres)', () => {
  const DAY_MS = 86_400_000;
  let adminPool: Pool;
  let admin: PoolClient;
  const zonePools: Pool[] = [];

  /** Zone FXS (UTC+0) / FXD (UTC+1) whose clocks change at 02:00 local on the day `daysFromNow` days away: back if `back`, else forward. */
  const zoneChangingAt = (daysFromNow: number, back: boolean): string => {
    const rule = (d: Date) => `M${d.getUTCMonth() + 1}.${Math.floor((d.getUTCDate() - 1) / 7) + 1}.${d.getUTCDay()}/2`;
    const at = new Date(Date.now() + daysFromNow * DAY_MS);
    const other = new Date(at.getTime() + 180 * DAY_MS);
    // POSIX: STD offset, DST offset, DST start rule, DST end rule. Back = DST ends at `at`; forward = DST starts at `at`.
    return back ? `FXS0FXD-1,${rule(other)},${rule(at)}` : `FXS0FXD-1,${rule(at)},${rule(other)}`;
  };
  const opsIn = (zone: string): Pool => {
    const p = new Pool({ connectionString: process.env.BILLING_DATABASE_URL_PLATFORM_OPS!, options: `-c TimeZone=${zone}` });
    zonePools.push(p);
    return p;
  };
  /** Runs one statement as the admin login with its session zone set to `zone`, committed so the ops pool sees it. */
  const setIn = async (zone: string, sql: string, params: unknown[]): Promise<void> => {
    await admin.query('BEGIN');
    try {
      await admin.query(`SELECT set_config('TimeZone', $1, true)`, [zone]);
      await admin.query(sql, params);
      await admin.query('COMMIT');
    } catch (e) {
      await admin.query('ROLLBACK');
      throw e;
    }
  };
  /** What the database itself computes for `expr`, as a UTC date. */
  const dbDate = async (zone: string, expr: string, id: string): Promise<string> => {
    await admin.query('BEGIN');
    try {
      await admin.query(`SELECT set_config('TimeZone', $1, true)`, [zone]);
      const { rows } = await admin.query<{ d: string }>(
        `SELECT to_char((${expr}) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d FROM accounts WHERE id = $1`,
        [id],
      );
      return rows[0]!.d;
    } finally {
      await admin.query('ROLLBACK');
    }
  };

  beforeAll(async () => {
    adminPool = createBillingPool(process.env.BILLING_DATABASE_URL!);
    admin = await adminPool.connect();
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), ...zonePools.map((p) => p.end())]);
  });

  it('clocks went back inside the grace: 30 minutes short of the database 7 days is still past due', async () => {
    const zone = zoneChangingAt(-3, true);
    const t = await seedAccountWithMember(admin, 'owner', { status: 'active' });
    // 7 calendar days back is 169 hours here, so this stamp is 168.5 hours old: a fixed 168 hours would call the grace over.
    await setIn(zone, `UPDATE accounts SET past_due_since = now() - interval '7 days' + interval '30 minutes' WHERE id = $1`, [t.accountId]);
    const summary = await readAccountBillingSummary({ pool: opsIn(zone), principal: t }, { accountId: t.accountId });
    expect(summary!.status).toBe('past_due');
    expect(summary!.reasons.map((r) => r.code)).toEqual(['past_due']);
    const until = await dbDate(zone, `past_due_since + interval '7 days'`, t.accountId);
    expect(summary!.reasons[0]!.message).toContain(`Agents keep running until ${until}.`);
  });

  it('clocks went forward inside the grace: 30 minutes past the database 7 days is cancelled', async () => {
    const zone = zoneChangingAt(-3, false);
    const t = await seedAccountWithMember(admin, 'owner', { status: 'active' });
    // 7 calendar days back is 167 hours here, so this stamp is 167.5 hours old: a fixed 168 hours would call the grace still running.
    await setIn(zone, `UPDATE accounts SET past_due_since = now() - interval '7 days' - interval '30 minutes' WHERE id = $1`, [t.accountId]);
    const summary = await readAccountBillingSummary({ pool: opsIn(zone), principal: t }, { accountId: t.accountId });
    expect(summary!.status).toBe('cancelled');
    expect(summary!.reasons.map((r) => r.code)).toEqual(['cancelled']);
    const purge = await dbDate(zone, `past_due_since + interval '7 days' + interval '30 days'`, t.accountId);
    expect(summary!.reasons[0]!.message).toContain(`saved until ${purge},`);
  });

  it('the saved-until date is the one the database computes, even where 720 hours lands on the other side of midnight', async () => {
    // Clocks go back in 10 days, inside the 30. The end sits 5 days back at 23:30 UTC, so the database's day (721 hours on) is 00:30 UTC the next day.
    const zone = zoneChangingAt(10, true);
    const t = await seedAccountWithMember(admin, 'owner', { status: 'active' });
    await setIn(
      zone,
      `UPDATE accounts SET stripe_subscription_status = 'canceled',
              subscription_ended_at = date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' - interval '5 days' + interval '23 hours 30 minutes'
        WHERE id = $1`,
      [t.accountId],
    );
    const summary = await readAccountBillingSummary({ pool: opsIn(zone), principal: t }, { accountId: t.accountId });
    const expected = await dbDate(zone, `subscription_ended_at + interval '30 days'`, t.accountId);
    const fixedMs = await dbDate(zone, `subscription_ended_at + interval '720 hours'`, t.accountId);
    expect(fixedMs).not.toBe(expected); // the case really separates a day count from 720 hours
    expect(summary!.reasons[0]!.message).toBe(
      `Your subscription has ended. Your repos, runs and settings are saved until ${expected}, then permanently deleted.`,
    );
  });
});
