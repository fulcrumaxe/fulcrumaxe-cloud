import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withPartner } from '../src/withPartner.js';
import { seedAccount } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#69 PR-A (migration 0606): accounts.status becomes a derived column.
 * See that migration file's own header for the full priority-order
 * rationale -- this test covers the pure derivation function directly
 * (a truth table, cheap -- no table row needed per case), the trigger's
 * accept/reject behavior on a real row, the platform_ops-only dedupe
 * ledger, and platform_set_pause_marker.
 */
describe('accounts.status derivation (D#69 migration 0606)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let platformOpsPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    platformOpsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await platformOpsPool.end();
  });

  const NOW = 'now()';
  const IN_GRACE = `now() - interval '6 days'`; // day 6: still within the 7-day window
  const GRACE_EXPIRED = `now() - interval '8 days'`; // day 8: past the 7-day window
  const SQL_NULL = 'NULL';

  async function derive(args: {
    stripeCustomerId?: string | null;
    pastDueSince?: string; // a SQL expression, or omitted for NULL
    ownerPausedAt?: string;
    partnerSuspendedAt?: string;
    platformHoldAt?: string;
    keyBrokenAt?: string;
  }): Promise<string> {
    const { rows } = await admin.query<{ status: string }>(
      `SELECT compute_account_status($1, ${args.pastDueSince ?? SQL_NULL}, ${args.ownerPausedAt ?? SQL_NULL}, ${
        args.partnerSuspendedAt ?? SQL_NULL
      }, ${args.platformHoldAt ?? SQL_NULL}, ${args.keyBrokenAt ?? SQL_NULL}) AS status`,
      [args.stripeCustomerId === undefined ? 'cus_x' : args.stripeCustomerId],
    );
    return rows[0]!.status;
  }

  it('truth table: every marker combination derives the documented priority (migration 0606 header)', async () => {
    // 1. Nothing set, has a customer: active.
    expect(await derive({ stripeCustomerId: 'cus_1' })).toBe('active');
    // 2. No customer at all: unsubscribed.
    expect(await derive({ stripeCustomerId: null })).toBe('unsubscribed');
    // 3. Owner-paused: paused.
    expect(await derive({ ownerPausedAt: NOW })).toBe('paused');
    // 4. Partner-suspended: paused.
    expect(await derive({ partnerSuspendedAt: NOW })).toBe('paused');
    // 5. Platform hold: paused.
    expect(await derive({ platformHoldAt: NOW })).toBe('paused');
    // 6. Key broken alone: model_key_broken.
    expect(await derive({ keyBrokenAt: NOW })).toBe('model_key_broken');
    // 7. Past due, day 0 (just failed): past_due.
    expect(await derive({ pastDueSince: NOW })).toBe('past_due');
    // 8. Past due, day 6 (grace window): past_due.
    expect(await derive({ pastDueSince: IN_GRACE })).toBe('past_due');
    // 9. Past due, day 8 (grace expired): cancelled.
    expect(await derive({ pastDueSince: GRACE_EXPIRED })).toBe('cancelled');
    // 10. No customer, but a marker is set anyway (should never happen via
    //     app code, but the derivation must still resolve deterministically):
    //     the marker outranks 'unsubscribed'.
    expect(await derive({ stripeCustomerId: null, ownerPausedAt: NOW })).toBe('paused');
    // 11. Security review fix round 2 (MUST-fix 1, CWE-841/863): past due
    //     (in grace) AND owner-paused: owner_paused_at now OUTRANKS
    //     past_due_since (the opposite of this row's original round-1
    //     assumption) -- a signed payment failure must never re-enable a
    //     paused account. accountLifecycle.ts's applyInvoicePaymentFailed
    //     does NOT clear owner_paused_at any more (also MUST-fix 1), so
    //     this row proves the derivation's OWN priority is what keeps the
    //     pause in force, not an app-level clear.
    expect(await derive({ pastDueSince: NOW, ownerPausedAt: NOW })).toBe('paused');
    // 12. Past due (grace expired) AND owner-paused: also paused -- the
    //     pause outranks past_due regardless of whether its grace window
    //     has expired.
    //     (0660: once the grace window has expired the account is
    //     `cancelled`, which now outranks every marker -- see
    //     billing-subscription-schema.test.ts for the full table.)
    expect(await derive({ pastDueSince: GRACE_EXPIRED, ownerPausedAt: NOW })).toBe('cancelled');
    // 13. Owner-paused AND key-broken: paused outranks model_key_broken.
    expect(await derive({ ownerPausedAt: NOW, keyBrokenAt: NOW })).toBe('paused');
    // 14. Partner-suspended AND past due: partner_suspended_at outranks past_due.
    expect(await derive({ partnerSuspendedAt: NOW, pastDueSince: NOW })).toBe('paused');
    // 14b. Security review fix round 2 (MUST-fix 1): key-broken AND past
    //      due (in grace): key_broken_at now outranks past_due_since too
    //      -- a signed payment failure must not re-enable a key-broken
    //      account either. Also holds with the grace window expired.
    expect(await derive({ keyBrokenAt: NOW, pastDueSince: NOW })).toBe('model_key_broken');
    //      With the grace window expired it is `cancelled` since 0660.
    expect(await derive({ keyBrokenAt: NOW, pastDueSince: GRACE_EXPIRED })).toBe('cancelled');
    // 15. Platform hold AND partner-suspended: platform_hold_at outranks
    //     partner_suspended_at (both would derive 'paused' regardless, but
    //     this exercises the actual CASE branch order).
    expect(await derive({ platformHoldAt: NOW, partnerSuspendedAt: NOW })).toBe('paused');
    // 16. Platform hold AND past due: platform hold still outranks past due.
    expect(await derive({ platformHoldAt: NOW, pastDueSince: NOW })).toBe('paused');
    // 17. Every marker set at once: platform_hold_at wins outright.
    expect(
      await derive({
        pastDueSince: NOW,
        ownerPausedAt: NOW,
        partnerSuspendedAt: NOW,
        platformHoldAt: NOW,
        keyBrokenAt: NOW,
      }),
    ).toBe('paused');
    // 18. Key-broken, no customer id: key_broken_at outranks unsubscribed.
    expect(await derive({ stripeCustomerId: null, keyBrokenAt: NOW })).toBe('model_key_broken');
    // 19. past_due_since exactly at the 7-day boundary is already expired
    //     (the CHECK is `>`, strictly within the window) -- day 7 exactly.
    expect(await derive({ pastDueSince: `now() - interval '7 days'` })).toBe('cancelled');
  });

  it('accounts_derive_status: an INSERT whose status literal agrees with derivation is accepted, and one that omits status derives the column default', async () => {
    // Spec A5 bullet: `INSERT INTO accounts (id) VALUES ($1)` gives
    // `status = 'unsubscribed'` -- the column DEFAULT already agrees with
    // the derived value for a brand-new, customer-free, marker-free row.
    const defaultOnlyId = randomUUID();
    await admin.query(`INSERT INTO accounts (id, plan) VALUES ($1, 'starter')`, [defaultOnlyId]);
    const { rows: defaultRows } = await admin.query<{ status: string }>(
      'SELECT status FROM accounts WHERE id = $1',
      [defaultOnlyId],
    );
    expect(defaultRows[0]!.status).toBe('unsubscribed');

    // A literal that already agrees with what stripe_customer_id derives
    // to is accepted outright (this is what every seed helper in this
    // repo now does).
    const agreeingId = randomUUID();
    await admin.query(
      `INSERT INTO accounts (id, plan, status, stripe_customer_id) VALUES ($1, 'starter', 'active', $2)`,
      [agreeingId, `cus_test_${agreeingId}`],
    );
    const { rows: agreeingRows } = await admin.query<{ status: string }>(
      'SELECT status FROM accounts WHERE id = $1',
      [agreeingId],
    );
    expect(agreeingRows[0]!.status).toBe('active');
  });

  it('accounts_derive_status: an INSERT whose status literal disagrees with derivation is rejected (42501), for every role -- security review MUST-fix 4 (Spec A5, CWE-754)', async () => {
    // Spec A5's own example: no stripe_customer_id (derives 'unsubscribed'),
    // but the statement insists on 'active'.
    const accountId = randomUUID();
    await expect(
      admin.query(
        `INSERT INTO accounts (id, plan, status, stripe_customer_id) VALUES ($1, 'starter', 'active', NULL)`,
        [accountId],
      ),
    ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });

    // Confirm nothing was written -- the whole INSERT statement aborted.
    const { rows } = await admin.query('SELECT 1 FROM accounts WHERE id = $1', [accountId]);
    expect(rows).toHaveLength(0);

    // Security review's own reproduction: a writer meaning "create this
    // account paused" must not silently get a running account back.
    // platform_ops (not just superuser) is rejected too.
    const pausedAttemptId = randomUUID();
    await expect(
      platformOpsPool.query(
        `INSERT INTO accounts (id, plan, status, stripe_customer_id) VALUES ($1, 'starter', 'paused', $2)`,
        [pausedAttemptId, `cus_test_${pausedAttemptId}`],
      ),
    ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
  });

  it('accounts_derive_status: a marker-only UPDATE never touches the status literal and is silently re-derived', async () => {
    const accountId = randomUUID();
    await seedAccount(admin, accountId);
    await platformOpsPool.query('UPDATE accounts SET owner_paused_at = now() WHERE id = $1', [accountId]);
    const { rows } = await platformOpsPool.query<{ status: string }>('SELECT status FROM accounts WHERE id = $1', [
      accountId,
    ]);
    expect(rows[0]!.status).toBe('paused');
  });

  it('accounts_derive_status: an UPDATE that explicitly writes a status literal disagreeing with derivation is rejected (42501), for every role', async () => {
    const accountId = randomUUID();
    await seedAccount(admin, accountId); // active: has a stripe_customer_id, no markers

    await expect(
      platformOpsPool.query(`UPDATE accounts SET status = 'paused' WHERE id = $1`, [accountId]),
    ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });

    const { rows } = await admin.query<{ status: string }>('SELECT status FROM accounts WHERE id = $1', [accountId]);
    expect(rows[0]!.status).toBe('active'); // unchanged -- the whole statement rolled back
  });

  it('accounts_derive_status: an UPDATE that writes a status literal already EQUAL to the derived value is a harmless no-op, not a rejection', async () => {
    const accountId = randomUUID();
    await seedAccount(admin, accountId);
    await expect(
      platformOpsPool.query(`UPDATE accounts SET status = 'active', updated_at = now() WHERE id = $1`, [accountId]),
    ).resolves.toBeDefined();
  });

  describe('stripe_webhook_events: platform_ops-only, FORCE RLS', () => {
    it('app_user has no grant of any kind on it', async () => {
      const appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
      try {
        await expect(
          appUserPool.query(`SELECT 1 FROM stripe_webhook_events LIMIT 1`),
        ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      } finally {
        await appUserPool.end();
      }
    });

    it('platform_ops can read and write it directly', async () => {
      const accountId = randomUUID();
      await seedAccount(admin, accountId);
      await platformOpsPool.query(
        `INSERT INTO stripe_webhook_events (stripe_event_id, stripe_event_type, account_id) VALUES ($1, 'invoice.paid', $2)`,
        [`evt_${randomUUID()}`, accountId],
      );
      const { rows } = await platformOpsPool.query('SELECT count(*)::int n FROM stripe_webhook_events WHERE account_id = $1', [
        accountId,
      ]);
      expect(rows[0].n).toBe(1);
    });
  });

  describe('platform_set_pause_marker (owner decision 18504974: hold marker supports reason = dispute)', () => {
    it('sets platform_hold_at and platform_hold_reason, derives status = paused, and audits via audit_write_system', async () => {
      const accountId = randomUUID();
      await seedAccount(admin, accountId);

      await platformOpsPool.query('SELECT platform_set_pause_marker($1, true, $2)', [accountId, 'dispute']);

      const { rows } = await admin.query<{ status: string; platform_hold_reason: string | null }>(
        'SELECT status, platform_hold_reason FROM accounts WHERE id = $1',
        [accountId],
      );
      expect(rows[0]).toMatchObject({ status: 'paused', platform_hold_reason: 'dispute' });

      const audit = await admin.query(
        `SELECT actor, action FROM audit_log WHERE account_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [accountId],
      );
      expect(audit.rows[0]).toMatchObject({ actor: 'system:platform_ops', action: 'account.platform_hold_set' });
    });

    it('clearing the hold restores whatever the OTHER markers derive (here: active)', async () => {
      const accountId = randomUUID();
      await seedAccount(admin, accountId);
      await platformOpsPool.query('SELECT platform_set_pause_marker($1, true, $2)', [accountId, 'dispute']);

      await platformOpsPool.query('SELECT platform_set_pause_marker($1, false, NULL)', [accountId]);

      const { rows } = await admin.query<{ status: string; platform_hold_reason: string | null }>(
        'SELECT status, platform_hold_reason FROM accounts WHERE id = $1',
        [accountId],
      );
      expect(rows[0]).toMatchObject({ status: 'active', platform_hold_reason: null });
    });

    it('security review SHOULD-fix 4 (CWE-20/778): rejects a NULL or whitespace-only reason when setting a hold, including tabs and newlines -- btrim() only strips spaces', async () => {
      const blankReasons = [null, '', '   ', '\t', '\n', ' \t\n '];
      for (const reason of blankReasons) {
        const accountId = randomUUID();
        await seedAccount(admin, accountId);
        await expect(
          platformOpsPool.query('SELECT platform_set_pause_marker($1, true, $2)', [accountId, reason]),
        ).rejects.toMatchObject({ code: '22023' });
        // Refused before any write -- no hold, no audit row.
        const { rows } = await admin.query<{ platform_hold_at: Date | null }>(
          'SELECT platform_hold_at FROM accounts WHERE id = $1',
          [accountId],
        );
        expect(rows[0]!.platform_hold_at).toBeNull();
      }
    });

    it('accepts a reason that is non-blank once real content is trimmed', async () => {
      const accountId = randomUUID();
      await seedAccount(admin, accountId);
      await platformOpsPool.query('SELECT platform_set_pause_marker($1, true, $2)', [accountId, '  dispute  ']);
      const { rows } = await admin.query<{ status: string; platform_hold_reason: string | null }>(
        'SELECT status, platform_hold_reason FROM accounts WHERE id = $1',
        [accountId],
      );
      expect(rows[0]).toMatchObject({ status: 'paused', platform_hold_reason: '  dispute  ' });
    });

    it('app_user has no EXECUTE grant', async () => {
      const appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
      try {
        await expect(
          appUserPool.query('SELECT platform_set_pause_marker($1, true, $2)', [randomUUID(), 'dispute']),
        ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      } finally {
        await appUserPool.end();
      }
    });
  });

  describe('partner_unsuspend_account', () => {
    let partnerUserPool: Pool;
    let partnerId: string;
    let accountId: string;
    let ownerUserId: string;

    beforeAll(async () => {
      partnerUserPool = createPool(process.env.DATABASE_URL_PARTNER_USER!);
      partnerId = randomUUID();
      await admin.query(`INSERT INTO partners (id, kind, status, name) VALUES ($1, 'reseller', 'active', 'Unsuspend Co')`, [
        partnerId,
      ]);
      const refs = await seedAccount(admin, randomUUID());
      accountId = refs.accountId;
      ownerUserId = refs.userId;
      await admin.query('UPDATE accounts SET partner_id = $1 WHERE id = $2', [partnerId, accountId]);
      await admin.query(`INSERT INTO partner_members (partner_id, user_id, role) VALUES ($1, $2, 'owner')`, [
        partnerId,
        ownerUserId,
      ]);
    });

    afterAll(async () => {
      await partnerUserPool.end();
    });

    it('unsuspends an account the caller\'s partner owns, clearing partner_suspended_at', async () => {
      await withPartner(partnerUserPool, partnerId, ownerUserId, async (client) => {
        await client.query('SELECT partner_suspend_account($1)', [accountId]);
      });
      expect((await admin.query('SELECT status FROM accounts WHERE id = $1', [accountId])).rows[0].status).toBe(
        'paused',
      );

      await withPartner(partnerUserPool, partnerId, ownerUserId, async (client) => {
        await client.query('SELECT partner_unsuspend_account($1)', [accountId]);
      });

      const { rows } = await admin.query<{ status: string; partner_suspended_at: Date | null }>(
        'SELECT status, partner_suspended_at FROM accounts WHERE id = $1',
        [accountId],
      );
      expect(rows[0]).toMatchObject({ status: 'active', partner_suspended_at: null });

      const audit = await admin.query(
        `SELECT action FROM partner_audit_log WHERE partner_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [partnerId],
      );
      expect(audit.rows[0].action).toBe('unsuspend_account');
    });

    it('refuses to unsuspend another partner\'s account: 0 rows changed, refusal audited', async () => {
      const otherPartnerId = randomUUID();
      await admin.query(`INSERT INTO partners (id, kind, status, name) VALUES ($1, 'reseller', 'active', 'Other')`, [
        otherPartnerId,
      ]);
      const victim = await seedAccount(admin, randomUUID());
      await admin.query('UPDATE accounts SET partner_id = $1, partner_suspended_at = now() WHERE id = $2', [
        otherPartnerId,
        victim.accountId,
      ]);

      await withPartner(partnerUserPool, partnerId, ownerUserId, async (client) => {
        await client.query('SELECT partner_unsuspend_account($1)', [victim.accountId]);
      });

      const { rows } = await admin.query<{ status: string }>('SELECT status FROM accounts WHERE id = $1', [
        victim.accountId,
      ]);
      expect(rows[0].status).toBe('paused'); // unchanged -- still suspended

      const audit = await admin.query(
        `SELECT action FROM partner_audit_log WHERE partner_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [partnerId],
      );
      expect(audit.rows[0].action).toBe('unsuspend_account_refused');
    });
  });
});
