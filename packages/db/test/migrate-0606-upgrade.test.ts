import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../src/pool.js';
import { withPartner } from '../src/withPartner.js';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../src/migrate.js';
import { throwawayDbs, type ThrowawayDbs } from './helpers/throwaway-db.js';

/**
 * D#69 PR-A: migration 0606's fail-closed backfill (see that file's own
 * header comment). Same shape as migrate-0005-upgrade.test.ts -- a fresh
 * database migrated at every file EXCEPT 0606, seeded with pre-0606 data,
 * then the real migrations directory picks up exactly 0606.
 */
// 0660 replaces objects 0606 creates (compute_account_status and its trigger
// function), so it cannot run before 0606: the "pre" database leaves it out
// too, and the upgrade step applies 0606 and then 0660.
const AFTER_0606 = ['0660_subscription_sync.sql', '0692_onboarding_progress_marks.sql', '0720_trigger_functions_not_owned_by_platform_ops.sql'];
const UPGRADE_APPLIED = ['0606_derived_account_status.sql', ...AFTER_0606];

describe('migrate: the 0606 upgrade path (D#69 fail-closed backfill)', () => {
  let adminPool: Pool;
  let dbName: string;
  let dbs: ThrowawayDbs;
  let tmpMigrationsDir: string | undefined;

  beforeAll(() => {
    adminPool = createPool(process.env.DATABASE_URL!);
    dbs = throwawayDbs(adminPool);
  });

  afterEach(async () => {
    if (tmpMigrationsDir) {
      rmSync(tmpMigrationsDir, { recursive: true, force: true });
      tmpMigrationsDir = undefined;
    }
    // Every test's pools are already ended (their `finally`), so this drops
    // the database that test created -- one per test, not just the last.
    await dbs.dropAll();
  });

  afterAll(async () => {
    await adminPool.end();
  });

  async function migrateExcept401(): Promise<Pool> {
    dbName = await dbs.create('fx_0606_upgrade');
    const dbUrl = new URL(process.env.DATABASE_URL!);
    dbUrl.pathname = `/${dbName}`;
    const pool = createPool(dbUrl.toString());

    const allFiles = readdirSync(DEFAULT_MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const preFiles = allFiles.filter((f) => f !== '0606_derived_account_status.sql' && !AFTER_0606.includes(f));
    expect(preFiles.length).toBe(allFiles.length - UPGRADE_APPLIED.length);

    tmpMigrationsDir = mkdtempSync(path.join(tmpdir(), 'fx-db-0606-upgrade-'));
    for (const f of preFiles) {
      copyFileSync(path.join(DEFAULT_MIGRATIONS_DIR, f), path.join(tmpMigrationsDir, f));
    }
    const preResult = await runMigrations(pool, tmpMigrationsDir);
    expect(preResult.applied).toEqual(preFiles);
    return pool;
  }

  it('backfills each legacy status onto the marker that re-derives it, and picks up exactly 0606', async () => {
    const pool = await migrateExcept401();
    try {
      const active = randomUUID();
      const pastDue = randomUUID();
      const paused = randomUUID();
      const keyBroken = randomUUID();
      await pool.query(`INSERT INTO accounts (id, plan, status, stripe_customer_id) VALUES ($1, 'starter', 'active', $2)`, [
        active,
        `cus_${active}`,
      ]);
      await pool.query(`INSERT INTO accounts (id, plan, status, stripe_customer_id) VALUES ($1, 'starter', 'past_due', $2)`, [
        pastDue,
        `cus_${pastDue}`,
      ]);
      // Security review fix round 2 (SHOULD-fix 6): the backfill no longer
      // hands a legacy past_due row a fresh 7-day window -- it looks for
      // the earliest recorded `invoice.payment_failed` webhook in the
      // pre-cutover audit_log ledger instead. Record one 2 days ago so this
      // account is genuinely still within grace and this test keeps
      // verifying "each legacy status maps onto the marker that re-derives
      // it", not the grace-window edge case (see the dedicated test below
      // for that).
      await pool.query(
        `INSERT INTO audit_log (account_id, actor, action, payload, created_at)
         VALUES ($1, 'system', 'stripe_webhook_event', $2, now() - interval '2 days')`,
        [pastDue, JSON.stringify({ stripeEventId: `evt_${pastDue}`, stripeEventType: 'invoice.payment_failed' })],
      );
      await pool.query(`INSERT INTO accounts (id, plan, status, stripe_customer_id) VALUES ($1, 'starter', 'paused', $2)`, [
        paused,
        `cus_${paused}`,
      ]);
      await pool.query(
        `INSERT INTO accounts (id, plan, status, stripe_customer_id) VALUES ($1, 'starter', 'model_key_broken', $2)`,
        [keyBroken, `cus_${keyBroken}`],
      );

      const realResult = await runMigrations(pool);
      expect(realResult.applied).toEqual(UPGRADE_APPLIED);

      const { rows } = await pool.query<{ id: string; status: string }>(
        'SELECT id, status FROM accounts WHERE id = ANY($1) ORDER BY id',
        [[active, pastDue, paused, keyBroken]],
      );
      const byId = new Map(rows.map((r) => [r.id, r.status]));
      expect(byId.get(active)).toBe('active');
      expect(byId.get(pastDue)).toBe('past_due');
      expect(byId.get(paused)).toBe('paused');
      expect(byId.get(keyBroken)).toBe('model_key_broken');

      const secondResult = await runMigrations(pool);
      expect(secondResult.applied).toEqual([]);
    } finally {
      await pool.end();
    }
  });

  it('security review SHOULD-fix 6: a legacy past_due row with no recorded failure event backfills with NO grace, not a fresh 7-day window', async () => {
    const pool = await migrateExcept401();
    try {
      const noEvidence = randomUUID();
      const withEvidence = randomUUID();
      await pool.query(`INSERT INTO accounts (id, plan, status, stripe_customer_id) VALUES ($1, 'starter', 'past_due', $2)`, [
        noEvidence,
        `cus_${noEvidence}`,
      ]);
      await pool.query(`INSERT INTO accounts (id, plan, status, stripe_customer_id) VALUES ($1, 'starter', 'past_due', $2)`, [
        withEvidence,
        `cus_${withEvidence}`,
      ]);
      // withEvidence has a real failure recorded 10 days ago -- outside the
      // 7-day grace window, so it must ALSO come out cancelled, proving the
      // earliest-event lookup is actually used (not just "any row present").
      await pool.query(
        `INSERT INTO audit_log (account_id, actor, action, payload, created_at)
         VALUES ($1, 'system', 'stripe_webhook_event', $2, now() - interval '10 days')`,
        [withEvidence, JSON.stringify({ stripeEventId: `evt_${withEvidence}`, stripeEventType: 'invoice.payment_failed' })],
      );

      const realResult = await runMigrations(pool);
      expect(realResult.applied).toEqual(UPGRADE_APPLIED);

      const { rows } = await pool.query<{ id: string; status: string; past_due_since: Date }>(
        'SELECT id, status, past_due_since FROM accounts WHERE id = ANY($1) ORDER BY id',
        [[noEvidence, withEvidence]],
      );
      const byId = new Map(rows.map((r) => [r.id, r]));
      // No evidence: falls back to now() - 7 days, which is exactly on the
      // strict `>` grace boundary -- no grace granted, status is cancelled.
      expect(byId.get(noEvidence)!.status).toBe('cancelled');
      // Evidence exists but is itself outside the window -- the real
      // first-failure time is used, not a fresh clock, so this is also
      // cancelled (not past_due, which a naive "backfill to now()" would
      // have produced).
      expect(byId.get(withEvidence)!.status).toBe('cancelled');
      expect(byId.get(withEvidence)!.past_due_since.getTime()).toBeLessThan(Date.now() - 9 * 24 * 60 * 60 * 1000);
    } finally {
      await pool.end();
    }
  });

  it('fails closed: an active account with no stripe_customer_id (ambiguous under the new derivation) stops the migration instead of silently reclassifying it', async () => {
    const pool = await migrateExcept401();
    try {
      const ambiguous = randomUUID();
      await pool.query(`INSERT INTO accounts (id, plan, status, stripe_customer_id) VALUES ($1, 'starter', 'active', NULL)`, [
        ambiguous,
      ]);

      await expect(runMigrations(pool)).rejects.toThrow(/would reclassify them as unsubscribed/i);

      // Confirm it genuinely did not apply -- schema_migrations has no row.
      const { rows } = await pool.query<{ filename: string }>(
        `SELECT filename FROM schema_migrations WHERE filename = '0606_derived_account_status.sql'`,
      );
      expect(rows).toHaveLength(0);

      // Resolve it manually (give it a customer id) and confirm a re-run now succeeds.
      await pool.query(`UPDATE accounts SET stripe_customer_id = $1 WHERE id = $2`, [`cus_${ambiguous}`, ambiguous]);
      const result = await runMigrations(pool);
      expect(result.applied).toEqual(UPGRADE_APPLIED);
    } finally {
      await pool.end();
    }
  });

  it('fails closed: a duplicate live stripe_customer_id stops the migration before the unique index is added', async () => {
    const pool = await migrateExcept401();
    try {
      const a = randomUUID();
      const b = randomUUID();
      const dupCus = `cus_dup_${randomUUID().slice(0, 8)}`;
      await pool.query(`INSERT INTO accounts (id, plan, status, stripe_customer_id) VALUES ($1, 'starter', 'active', $2)`, [
        a,
        dupCus,
      ]);
      await pool.query(`INSERT INTO accounts (id, plan, status, stripe_customer_id) VALUES ($1, 'starter', 'active', $2)`, [
        b,
        dupCus,
      ]);

      await expect(runMigrations(pool)).rejects.toThrow(/duplicate stripe_customer_id/i);
    } finally {
      await pool.end();
    }
  });

  it('security review: the end-of-migration backfill self-check catches a row the earlier steps do not cover -- a soft-deleted active row with no stripe_customer_id', async () => {
    const pool = await migrateExcept401();
    try {
      // The step-2 "ambiguous active, no customer" guard only counts rows
      // with `deleted_at IS NULL`, so a soft-deleted 'active' row with no
      // stripe_customer_id sails past it -- nothing backfills a marker for
      // it (no backfill step touches 'active' rows at all), yet
      // compute_account_status ignores deleted_at and derives
      // 'unsubscribed' for it. That is a genuine stored-vs-derived
      // mismatch only the migration's own closing self-check (step 11)
      // catches. If that DO block were removed, this migration would
      // instead succeed silently, leaving the mismatched row behind --
      // exactly what this test would then fail to observe.
      const accountId = randomUUID();
      await pool.query(
        `INSERT INTO accounts (id, plan, status, stripe_customer_id, deleted_at) VALUES ($1, 'starter', 'active', NULL, now())`,
        [accountId],
      );

      await expect(runMigrations(pool)).rejects.toThrow(/stored status that does not match the derived value/i);

      const { rows } = await pool.query<{ filename: string }>(
        `SELECT filename FROM schema_migrations WHERE filename = '0606_derived_account_status.sql'`,
      );
      expect(rows).toHaveLength(0);
    } finally {
      await pool.end();
    }
  });

  it(
    'security review MUST-fix 1 (CWE-863): a legacy partner suspension backfills to ' +
      'platform_hold_at, not owner_paused_at -- so an owner cannot silently lift a reseller\'s hold',
    async () => {
      const pool = await migrateExcept401();
      let partnerUserPool: Pool | undefined;
      try {
        // Pre-0606: partner_suspend_account (0200's real, un-migrated
        // version) writes plain `status = 'paused'` directly -- identical
        // to what an owner's own pause would have written back then. This
        // is exactly the ambiguity the security review flagged: nothing
        // left in the row says which holder caused it.
        const partnerId = randomUUID();
        const userId = randomUUID();
        const accountId = randomUUID();
        await pool.query(
          `INSERT INTO partners (id, kind, status, name) VALUES ($1, 'reseller', 'active', 'R1')`,
          [partnerId],
        );
        await pool.query(
          `INSERT INTO accounts (id, plan, status, stripe_customer_id, partner_id) VALUES ($1, 'starter', 'active', $2, $3)`,
          [accountId, `cus_${accountId}`, partnerId],
        );
        await pool.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [userId, `${userId}@example.test`]);
        await pool.query(`INSERT INTO partner_members (partner_id, user_id, role) VALUES ($1, $2, 'owner')`, [
          partnerId,
          userId,
        ]);

        const partnerUserUrl = new URL(process.env.DATABASE_URL_PARTNER_USER!);
        partnerUserUrl.pathname = `/${dbName}`;
        partnerUserPool = createPool(partnerUserUrl.toString());
        await withPartner(partnerUserPool, partnerId, userId, async (client) => {
          await client.query('SELECT partner_suspend_account($1)', [accountId]);
        });

        const { rows: preRows } = await pool.query<{ status: string }>(
          'SELECT status FROM accounts WHERE id = $1',
          [accountId],
        );
        expect(preRows[0]!.status).toBe('paused'); // pre-0606: the old plain write, no marker column exists yet

        const realResult = await runMigrations(pool);
        expect(realResult.applied).toEqual(UPGRADE_APPLIED);

        const { rows: postRows } = await pool.query<{
          status: string;
          owner_paused_at: Date | null;
          partner_suspended_at: Date | null;
          platform_hold_at: Date | null;
        }>(
          'SELECT status, owner_paused_at, partner_suspended_at, platform_hold_at FROM accounts WHERE id = $1',
          [accountId],
        );
        expect(postRows[0]!.status).toBe('paused');
        // The MUST-fix: NOT owner_paused_at (that would let the owner's
        // own resumeAccount silently lift a reseller's suspension).
        expect(postRows[0]!.owner_paused_at).toBeNull();
        expect(postRows[0]!.partner_suspended_at).toBeNull();
        expect(postRows[0]!.platform_hold_at).not.toBeNull();

        // The migration's own closing assertion (security review's
        // second half of MUST-fix 1) must have found this row consistent
        // -- it already ran as part of runMigrations() above without
        // throwing, but assert the invariant directly too.
        const { rows: deriveCheck } = await pool.query<{ matches: boolean }>(
          `SELECT status = compute_account_status(
             stripe_customer_id, past_due_since, owner_paused_at, partner_suspended_at, platform_hold_at, key_broken_at
           ) AS matches
           FROM accounts WHERE id = $1`,
          [accountId],
        );
        expect(deriveCheck[0]!.matches).toBe(true);

        // resumeAccount's own DB effect (packages/billing/src/
        // accountLifecycle.ts) is exactly this UPDATE, run as
        // platform_ops, after authorization -- db has no dependency on
        // billing to call the TS function directly, so this reproduces
        // its write. Since owner_paused_at was never set (platform_hold_at
        // was), this must NOT lift the pause.
        const platformOpsUrl = new URL(process.env.DATABASE_URL_PLATFORM_OPS!);
        platformOpsUrl.pathname = `/${dbName}`;
        const platformOpsPool = createPool(platformOpsUrl.toString());
        try {
          await platformOpsPool.query('UPDATE accounts SET owner_paused_at = NULL, updated_at = now() WHERE id = $1', [
            accountId,
          ]);
        } finally {
          await platformOpsPool.end();
        }

        const { rows: afterResume } = await pool.query<{ status: string; platform_hold_at: Date | null }>(
          'SELECT status, platform_hold_at FROM accounts WHERE id = $1',
          [accountId],
        );
        expect(afterResume[0]!.status).toBe('paused');
        expect(afterResume[0]!.platform_hold_at).not.toBeNull();
      } finally {
        if (partnerUserPool) await partnerUserPool.end();
        await pool.end();
      }
    },
  );

  it(
    'security review fix round 3 MUST-fix 1 (CWE-345/CWE-841): a legacy past_due row whose ' +
      'payment-failure evidence is forged with a future created_at is capped at the migration\'s ' +
      'own clock, not granted an indefinite grace window',
    async () => {
      const pool = await migrateExcept401();
      try {
        // Pre-0008, app_user could INSERT into audit_log with any
        // created_at it chose (0008's own header records two live
        // exploits of exactly that) -- so a tenant forging a
        // payment-failure row dated a year in the future is exactly the
        // pre-cutover ledger state this migration reads as evidence.
        const forged = randomUUID();
        await pool.query(`INSERT INTO accounts (id, plan, status, stripe_customer_id) VALUES ($1, 'starter', 'past_due', $2)`, [
          forged,
          `cus_${forged}`,
        ]);
        await pool.query(
          `INSERT INTO audit_log (account_id, actor, action, payload, created_at)
           VALUES ($1, 'system', 'stripe_webhook_event', $2, now() + interval '1 year')`,
          [forged, JSON.stringify({ stripeEventId: `evt_${forged}`, stripeEventType: 'invoice.payment_failed' })],
        );

        const realResult = await runMigrations(pool);
        expect(realResult.applied).toEqual(UPGRADE_APPLIED);

        const { rows } = await pool.query<{ status: string; past_due_since: Date }>(
          'SELECT status, past_due_since FROM accounts WHERE id = $1',
          [forged],
        );
        const pastDueSince = rows[0]!.past_due_since;

        // The MUST-fix: without the LEAST(..., now()) cap this reads a
        // year in the future. A 2s tolerance absorbs clock skew between
        // this process and the test database server -- it cannot mask the
        // vulnerability, which puts the timestamp a year off, not a few
        // seconds.
        expect(pastDueSince.getTime()).toBeLessThanOrEqual(Date.now() + 2000);
        // The capped value lands within the last few seconds (migration
        // time), so the row reads as a fresh, honest failure -- 'past_due',
        // not 'cancelled'.
        expect(rows[0]!.status).toBe('past_due');

        // Mirrors packages/spend/src/reserve.ts's reserve() grace-window
        // check exactly: `status === 'past_due' && pastDueSince !== null
        // && pastDueSince.getTime() > now.getTime() - 7 * 24 * 60 * 60 *
        // 1000`. packages/db has no dependency on packages/spend (and
        // adding one is out of scope for this fix), so this reproduces
        // reserve()'s own formula against the migration's actual output
        // instead of importing it.
        const withinGrace = (asOfMs: number): boolean => pastDueSince.getTime() > asOfMs - 7 * 24 * 60 * 60 * 1000;

        // Immediately after migration: admitted, same grace an honest,
        // just-failed account gets.
        expect(withinGrace(Date.now())).toBe(true);
        // 8 days after the (capped) past_due_since: reserve() must now
        // deny. Before this fix, past_due_since sat a year in the future,
        // so this same check stayed true (admitted) for the next ~357
        // days -- an unpaying, forged account kept running far past any
        // 7-day grace.
        expect(withinGrace(pastDueSince.getTime() + 8 * 24 * 60 * 60 * 1000)).toBe(false);
      } finally {
        await pool.end();
      }
    },
  );
});
