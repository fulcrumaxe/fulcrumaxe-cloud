import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../src/migrate.js';
import { seedAccount } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';
import { throwawayDbs, type ThrowawayDbs } from './helpers/throwaway-db.js';

/**
 * D#69 B1 (migration 0660): the Stripe subscription columns on accounts, and
 * the `cancelled` derivation that a fetched subscription can reach. Owner
 * question 1 is built as option A: `cancelled` outranks every marker. The
 * precedence lives in ONE test (B1-4's truth table) so an owner answer of B
 * changes that test's rows and nothing else in this file.
 */
const MIGRATION = '0660_subscription_sync.sql';
// Applied after 0660 and reading its columns (0692 backfills from them), so the upgrade database leaves it out too.
const AFTER_MIGRATION = ['0692_onboarding_progress_marks.sql', '0720_trigger_functions_not_owned_by_platform_ops.sql'];

describe('accounts subscription schema (D#69 migration 0660)', () => {
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

  describe('B1-1: applies on top of an existing database, keeps every status, re-runs as a no-op', () => {
    let dbs: ThrowawayDbs;
    let tmpDir: string | undefined;

    beforeAll(() => {
      dbs = throwawayDbs(adminPool);
    });

    afterEach(async () => {
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
      await dbs.dropAll();
    });

    it('one account per status keeps its status through the migration, and a second run applies nothing', async () => {
      const dbName = await dbs.create('fx_0660_upgrade');
      const dbUrl = new URL(process.env.DATABASE_URL!);
      dbUrl.pathname = `/${dbName}`;
      const pool = createPool(dbUrl.toString());
      try {
        const all = readdirSync(DEFAULT_MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
        const pre = all.filter((f) => f !== MIGRATION && !AFTER_MIGRATION.includes(f));
        expect(pre.length).toBe(all.length - 1 - AFTER_MIGRATION.length);
        tmpDir = mkdtempSync(path.join(tmpdir(), 'fx-db-0660-'));
        for (const f of pre) copyFileSync(path.join(DEFAULT_MIGRATIONS_DIR, f), path.join(tmpDir, f));
        expect((await runMigrations(pool, tmpDir)).applied).toEqual(pre);

        // One account per status the 0606 derivation can produce. Each is
        // inserted with a neutral row, then moved to its status through the
        // marker it derives from (a status literal cannot be written directly).
        const cases: Array<{ status: string; set: string; customer: boolean }> = [
          { status: 'unsubscribed', set: '', customer: false },
          { status: 'active', set: '', customer: true },
          { status: 'past_due', set: `past_due_since = now() - interval '2 days'`, customer: true },
          { status: 'cancelled', set: `past_due_since = now() - interval '9 days'`, customer: true },
          { status: 'paused', set: `owner_paused_at = now()`, customer: true },
          { status: 'model_key_broken', set: `key_broken_at = now()`, customer: true },
        ];
        const ids = new Map<string, string>();
        for (const c of cases) {
          const id = randomUUID();
          ids.set(c.status, id);
          await pool.query(
            `INSERT INTO accounts (id, plan, stripe_customer_id, status) VALUES ($1, 'starter', $2, $3)`,
            [id, c.customer ? `cus_${id}` : null, c.customer ? 'active' : 'unsubscribed'],
          );
          if (c.set) await pool.query(`UPDATE accounts SET ${c.set} WHERE id = $1`, [id]);
        }
        const read = async () => {
          const { rows } = await pool.query<{ id: string; status: string }>(
            'SELECT id, status FROM accounts WHERE id = ANY($1)',
            [[...ids.values()]],
          );
          return new Map(rows.map((r) => [r.id, r.status]));
        };
        const before = await read();
        for (const c of cases) expect(before.get(ids.get(c.status)!)).toBe(c.status);

        expect((await runMigrations(pool)).applied).toEqual([MIGRATION, ...AFTER_MIGRATION]);
        expect(await read()).toEqual(before);

        // The runner records it, so a second run applies nothing...
        expect((await runMigrations(pool)).applied).toEqual([]);
        // ...and the file itself is safe to execute again on an applied database.
        await pool.query(readFileSync(path.join(DEFAULT_MIGRATIONS_DIR, MIGRATION), 'utf8'));
        expect(await read()).toEqual(before);
      } finally {
        await pool.end();
      }
    });
  });

  describe('B1-2: the eight columns', () => {
    it('exist with the documented types, nullability and defaults', async () => {
      const { rows } = await admin.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        `SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_name = 'accounts' AND table_schema = 'public'
            AND column_name = ANY($1)
          ORDER BY column_name`,
        [
          [
            'stripe_subscription_id',
            'stripe_subscription_status',
            'stripe_cancel_at_period_end',
            'stripe_current_period_end',
            'stripe_synced_at',
            'subscription_ended_at',
            'terms_accepted_at',
            'terms_policy_version',
          ],
        ],
      );
      const col = new Map(rows.map((r) => [r.column_name, r]));
      expect(col.size).toBe(8);
      const text = ['stripe_subscription_id', 'stripe_subscription_status', 'terms_policy_version'];
      const ts = ['stripe_current_period_end', 'stripe_synced_at', 'subscription_ended_at', 'terms_accepted_at'];
      for (const c of text) expect(col.get(c)).toMatchObject({ data_type: 'text', is_nullable: 'YES' });
      for (const c of ts) {
        expect(col.get(c)).toMatchObject({ data_type: 'timestamp with time zone', is_nullable: 'YES' });
      }
      expect(col.get('stripe_cancel_at_period_end')).toMatchObject({
        data_type: 'boolean',
        is_nullable: 'NO',
        column_default: 'false',
      });
    });

    it('stripe_subscription_status accepts Stripe’s eight values and rejects anything else (23514)', async () => {
      const accountId = randomUUID();
      await seedAccount(admin, accountId);
      for (const v of [
        'incomplete',
        'incomplete_expired',
        'trialing',
        'active',
        'past_due',
        'canceled',
        'unpaid',
        'paused',
      ]) {
        await platformOpsPool.query(`UPDATE accounts SET stripe_subscription_status = $2 WHERE id = $1`, [accountId, v]);
      }
      await expect(
        platformOpsPool.query(`UPDATE accounts SET stripe_subscription_status = 'bogus' WHERE id = $1`, [accountId]),
      ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      // NULL (never synced) is allowed.
      await platformOpsPool.query(`UPDATE accounts SET stripe_subscription_status = NULL WHERE id = $1`, [accountId]);
    });
  });

  // B1-3 (app_user 42501, platform_ops succeeds, per column) is in
  // accounts-privileges.test.ts next to the other accounts grant checks.

  describe('B1-4: derivation truth table (owner question 1, option A -- flips if the owner answers B)', () => {
    const NOW = 'now()';
    const DAY6 = `now() - interval '6 days'`;
    const DAY8 = `now() - interval '8 days'`;

    async function derive(a: {
      customer?: string | null;
      pastDue?: string;
      owner?: string;
      partner?: string;
      hold?: string;
      key?: string;
      ended?: string;
    }): Promise<string> {
      const n = (v: string | undefined) => v ?? 'NULL';
      const { rows } = await admin.query<{ s: string }>(
        `SELECT compute_account_status($1, ${n(a.pastDue)}, ${n(a.owner)}, ${n(a.partner)}, ${n(a.hold)}, ${n(a.key)}, ${n(a.ended)}) AS s`,
        [a.customer === undefined ? 'cus_x' : a.customer],
      );
      return rows[0]!.s;
    }

    it('cancelled outranks every marker; the rest keep 0606’s order', async () => {
      // The new input alone, with a paying customer or none.
      expect(await derive({ ended: NOW })).toBe('cancelled');
      expect(await derive({ ended: NOW, customer: null })).toBe('cancelled');
      // Subscription ended, stacked with each marker: cancelled wins.
      expect(await derive({ ended: NOW, owner: NOW })).toBe('cancelled');
      expect(await derive({ ended: NOW, hold: NOW })).toBe('cancelled');
      expect(await derive({ ended: NOW, partner: NOW })).toBe('cancelled');
      expect(await derive({ ended: NOW, key: NOW })).toBe('cancelled');
      expect(await derive({ ended: NOW, pastDue: NOW })).toBe('cancelled');
      expect(await derive({ ended: NOW, pastDue: DAY6, owner: NOW, partner: NOW, hold: NOW, key: NOW })).toBe(
        'cancelled',
      );

      // past_due_since alone: day 0 and day 6 in grace, day 8 expired.
      expect(await derive({ pastDue: NOW })).toBe('past_due');
      expect(await derive({ pastDue: DAY6 })).toBe('past_due');
      expect(await derive({ pastDue: DAY8 })).toBe('cancelled');

      // PR-A fix round 2 is kept: inside the grace window a pause or a
      // broken key still outranks past_due.
      expect(await derive({ owner: NOW, pastDue: NOW })).toBe('paused');
      expect(await derive({ owner: NOW, pastDue: DAY6 })).toBe('paused');
      expect(await derive({ key: NOW, pastDue: NOW })).toBe('model_key_broken');
      expect(await derive({ key: NOW, pastDue: DAY6 })).toBe('model_key_broken');
      expect(await derive({ hold: NOW, pastDue: NOW })).toBe('paused');
      expect(await derive({ partner: NOW, pastDue: NOW })).toBe('paused');

      // Option A also puts the grace-expired cancelled above the markers.
      expect(await derive({ owner: NOW, pastDue: DAY8 })).toBe('cancelled');
      expect(await derive({ hold: NOW, pastDue: DAY8 })).toBe('cancelled');
      expect(await derive({ partner: NOW, pastDue: DAY8 })).toBe('cancelled');
      expect(await derive({ key: NOW, pastDue: DAY8 })).toBe('cancelled');

      // Markers with no subscription end: unchanged from 0606.
      expect(await derive({ hold: NOW, owner: NOW, key: NOW })).toBe('paused');
      expect(await derive({ owner: NOW, key: NOW })).toBe('paused');
      expect(await derive({ key: NOW })).toBe('model_key_broken');
      expect(await derive({ customer: null })).toBe('unsubscribed');
      expect(await derive({})).toBe('active');
    });

    it('property: nothing 0606 calls non-runnable becomes runnable, and an ended subscription is never runnable', async () => {
      // 0606's derivation, restated. Runnable = active, or past_due (which
      // only ever derives inside the grace window).
      const old = (r: { customer: boolean; pd: string; owner: boolean; partner: boolean; hold: boolean; key: boolean }) => {
        if (r.hold || r.partner || r.owner) return 'paused';
        if (r.key) return 'model_key_broken';
        if (r.pd === 'day0' || r.pd === 'day6') return 'past_due';
        if (r.pd === 'day8') return 'cancelled';
        return r.customer ? 'active' : 'unsubscribed';
      };
      const runnable = (s: string) => s === 'active' || s === 'past_due';

      const { rows } = await admin.query<{
        customer: boolean;
        pd: string;
        owner: boolean;
        partner: boolean;
        hold: boolean;
        key: boolean;
        ended: boolean;
        s: string;
      }>(
        `SELECT c AS customer, pd, o AS owner, p AS partner, h AS hold, k AS key, e AS ended,
                compute_account_status(
                  CASE WHEN c THEN 'cus_x' END,
                  CASE pd WHEN 'day0' THEN now() WHEN 'day6' THEN now() - interval '6 days'
                          WHEN 'day8' THEN now() - interval '8 days' END,
                  CASE WHEN o THEN now() END, CASE WHEN p THEN now() END,
                  CASE WHEN h THEN now() END, CASE WHEN k THEN now() END,
                  CASE WHEN e THEN now() END) AS s
           FROM (VALUES (true), (false)) AS cu(c),
                (VALUES ('none'), ('day0'), ('day6'), ('day8')) AS pdv(pd),
                (VALUES (true), (false)) AS ov(o), (VALUES (true), (false)) AS pv(p),
                (VALUES (true), (false)) AS hv(h), (VALUES (true), (false)) AS kv(k),
                (VALUES (true), (false)) AS ev(e)`,
      );
      expect(rows).toHaveLength(2 * 4 * 2 * 2 * 2 * 2 * 2);
      for (const r of rows) {
        if (!runnable(old(r))) expect(runnable(r.s), JSON.stringify(r)).toBe(false);
        if (r.ended) expect(r.s, JSON.stringify(r)).toBe('cancelled');
      }
    });
  });

  describe('B1-5: the trigger contract on the new function', () => {
    it('a direct status write that does not match the derivation is rejected (42501), with subscription_ended_at set', async () => {
      const accountId = randomUUID();
      await seedAccount(admin, accountId);
      await platformOpsPool.query(`UPDATE accounts SET subscription_ended_at = now() WHERE id = $1`, [accountId]);
      const cur = await admin.query<{ status: string }>('SELECT status FROM accounts WHERE id = $1', [accountId]);
      expect(cur.rows[0]!.status).toBe('cancelled');

      await expect(
        platformOpsPool.query(`UPDATE accounts SET status = 'active' WHERE id = $1`, [accountId]),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });

      // Setting the marker and a status that does not match it, together.
      const other = randomUUID();
      await seedAccount(admin, other);
      await expect(
        platformOpsPool.query(`UPDATE accounts SET subscription_ended_at = now(), status = 'paused' WHERE id = $1`, [
          other,
        ]),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });

      // An INSERT whose literal disagrees with derivation is rejected too.
      await expect(
        platformOpsPool.query(
          `INSERT INTO accounts (id, plan, stripe_customer_id, subscription_ended_at, status)
           VALUES ($1, 'starter', 'cus_ins', now(), 'active')`,
          [randomUUID()],
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('clearing subscription_ended_at re-derives the status', async () => {
      const accountId = randomUUID();
      await seedAccount(admin, accountId);
      await platformOpsPool.query(`UPDATE accounts SET subscription_ended_at = now() WHERE id = $1`, [accountId]);
      await platformOpsPool.query(`UPDATE accounts SET subscription_ended_at = NULL WHERE id = $1`, [accountId]);
      const { rows } = await admin.query<{ status: string }>('SELECT status FROM accounts WHERE id = $1', [accountId]);
      expect(rows[0]!.status).toBe('active');
    });
  });
});
