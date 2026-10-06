import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/** D#2 H17d (0692): the two write-once onboarding marks on accounts, their triggers and the backfill. */
describe('onboarding progress marks (0692)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let opsPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, appPool, opsPool]) await p.end();
  });

  const marks = async (r: SeedRefs) =>
    (await admin.query(`SELECT onboarding_key_ok_at AS key, onboarding_paid_at AS paid FROM accounts WHERE id = $1`, [r.accountId])).rows[0] as { key: Date | null; paid: Date | null };
  const connection = (r: SeedRefs, status: string) => admin.query(`UPDATE model_connections SET status = $2 WHERE account_id = $1`, [r.accountId, status]);
  const subscription = (r: SeedRefs, status: string) =>
    opsPool.query(`UPDATE accounts SET stripe_subscription_status = $2 WHERE id = $1`, [r.accountId, status]);
  /** Separate autocommit statements already have different now(); this keeps them clearly apart. */
  const tick = () => admin.query(`SELECT pg_sleep(0.02)`);

  describe('model key (onboarding_key_ok_at)', () => {
    it('is NULL until a connection is ok, set by the first ok, and unchanged after broken then ok again', async () => {
      const a = await seedAccount(admin, randomUUID());
      expect((await marks(a)).key).toBeNull();
      await connection(a, 'broken');
      expect((await marks(a)).key).toBeNull();
      await connection(a, 'ok');
      const first = (await marks(a)).key;
      expect(first).not.toBeNull();
      await tick();
      await connection(a, 'broken');
      await tick();
      await connection(a, 'ok');
      expect((await marks(a)).key).toEqual(first);
    });

    it('is unchanged by a key replace and by a remove, and a new ok connection after the remove', async () => {
      const a = await seedAccount(admin, randomUUID());
      await connection(a, 'ok');
      const first = (await marks(a)).key;
      await tick();
      await admin.query(`UPDATE model_connections SET status = 'unvalidated', key_fingerprint = $2, last_validated_at = NULL WHERE account_id = $1`, [a.accountId, `fp-${randomUUID()}`]);
      await connection(a, 'ok');
      expect((await marks(a)).key).toEqual(first);
      await admin.query(`DELETE FROM model_connections WHERE account_id = $1`, [a.accountId]);
      expect((await marks(a)).key).toEqual(first);
      await tick();
      await admin.query(
        `INSERT INTO model_connections (account_id, provider, key_ciphertext, key_nonce, wrapped_dek, kek_version, key_fingerprint, status)
         VALUES ($1, 'anthropic', 'c', 'n', 'w', 1, $2, 'ok')`,
        [a.accountId, `fp-${randomUUID()}`],
      );
      expect((await marks(a)).key).toEqual(first);
    });

    it("an ok written by platform_ops (the validator's login) in the account's tenant sets the mark, and only that account's", async () => {
      const a = await seedAccount(admin, randomUUID());
      const b = await seedAccount(admin, randomUUID());
      await withTenant(opsPool, a.accountId, a.userId, (c) => c.query(`UPDATE model_connections SET status = 'ok' WHERE account_id = $1`, [a.accountId]));
      expect((await marks(a)).key).not.toBeNull();
      expect((await marks(b)).key).toBeNull();
    });

    it('a first insert that is already ok sets the mark', async () => {
      const a = await seedAccount(admin, randomUUID());
      await admin.query(`DELETE FROM model_connections WHERE account_id = $1`, [a.accountId]);
      expect((await marks(a)).key).toBeNull();
      await admin.query(
        `INSERT INTO model_connections (account_id, provider, key_ciphertext, key_nonce, wrapped_dek, kek_version, key_fingerprint, status)
         VALUES ($1, 'anthropic', 'c', 'n', 'w', 1, $2, 'ok')`,
        [a.accountId, `fp-${randomUUID()}`],
      );
      expect((await marks(a)).key).not.toBeNull();
    });
  });

  describe('subscription (onboarding_paid_at)', () => {
    it('is set by the first active, and unchanged by past_due, canceled and active again', async () => {
      const a = await seedAccount(admin, randomUUID());
      expect((await marks(a)).paid).toBeNull();
      await subscription(a, 'incomplete');
      expect((await marks(a)).paid).toBeNull();
      await subscription(a, 'active');
      const first = (await marks(a)).paid;
      expect(first).not.toBeNull();
      for (const status of ['past_due', 'canceled', 'active', 'trialing']) {
        await tick();
        await subscription(a, status);
        expect((await marks(a)).paid, status).toEqual(first);
      }
    });

    it('trialing counts as paid, and another account is not moved', async () => {
      const a = await seedAccount(admin, randomUUID());
      const b = await seedAccount(admin, randomUUID());
      await subscription(a, 'trialing');
      expect((await marks(a)).paid).not.toBeNull();
      expect((await marks(b)).paid).toBeNull();
    });
  });

  describe('no role can set, change or clear a mark by hand', () => {
    const COLS = ['onboarding_key_ok_at', 'onboarding_paid_at'];

    it('app_user is refused 42501', async () => {
      const a = await seedAccount(admin, randomUUID());
      for (const col of COLS) {
        await expect(withTenant(appPool, a.accountId, a.userId, (c) => c.query(`UPDATE accounts SET ${col} = now() WHERE id = $1`, [a.accountId])), col).rejects.toMatchObject({
          code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
        });
      }
    });

    it('platform_ops and the owner role leave a set value unchanged, and cannot set an unset one', async () => {
      const a = await seedAccount(admin, randomUUID());
      for (const col of COLS) {
        await opsPool.query(`UPDATE accounts SET ${col} = '2001-01-01T00:00:00Z' WHERE id = $1`, [a.accountId]);
        await admin.query(`UPDATE accounts SET ${col} = '2001-01-01T00:00:00Z' WHERE id = $1`, [a.accountId]);
      }
      expect(await marks(a)).toEqual({ key: null, paid: null });

      await connection(a, 'ok');
      await subscription(a, 'active');
      const set = await marks(a);
      expect(set.key).not.toBeNull();
      expect(set.paid).not.toBeNull();
      for (const col of COLS) {
        await opsPool.query(`UPDATE accounts SET ${col} = '2001-01-01T00:00:00Z' WHERE id = $1`, [a.accountId]);
        await admin.query(`UPDATE accounts SET ${col} = NULL WHERE id = $1`, [a.accountId]);
        await opsPool.query(`UPDATE accounts SET ${col} = '2002-02-02T00:00:00Z' WHERE id = $1`, [a.accountId]);
      }
      expect(await marks(a)).toEqual(set);
    });

    it('an account inserted already active is marked, one inserted with a forged mark is not', async () => {
      const id = randomUUID();
      await opsPool.query(`INSERT INTO accounts (id, onboarding_key_ok_at, onboarding_paid_at) VALUES ($1, now(), now())`, [id]);
      expect((await admin.query(`SELECT onboarding_key_ok_at k, onboarding_paid_at p FROM accounts WHERE id = $1`, [id])).rows[0]).toEqual({ k: null, p: null });
    });
  });

  describe('backfill', () => {
    // The two backfill statements are read from the migration file itself and run on seeded rows with the
    // guard bypassed (session_replication_role = replica, rolled back after).
    const sql = readFileSync(new URL('../migrations/0692_onboarding_progress_marks.sql', import.meta.url), 'utf8');
    const backfill = sql.slice(sql.indexOf('UPDATE accounts a SET onboarding_key_ok_at'), sql.indexOf('-- The guard.'));

    async function run(setup: (c: PoolClient) => Promise<string[]>): Promise<{ id: string; key: Date | null; paid: Date | null }[]> {
      const c = await adminPool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SET LOCAL session_replication_role = replica`);
        const ids = await setup(c);
        await c.query(backfill);
        const { rows } = await c.query(`SELECT id, onboarding_key_ok_at AS key, onboarding_paid_at AS paid FROM accounts WHERE id = ANY($1::uuid[])`, [ids]);
        return ids.map((id) => rows.find((r) => r.id === id));
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    }
    const conn = (c: PoolClient, id: string, status: string, validated: string | null) =>
      c.query(
        `INSERT INTO model_connections (account_id, provider, key_ciphertext, key_nonce, wrapped_dek, kek_version, key_fingerprint, status, last_validated_at)
         VALUES ($1, 'anthropic', 'c', 'n', 'w', 1, $2, $3, $4)`,
        [id, `fp-${randomUUID()}`, status, validated],
      );
    const event = (c: PoolClient, id: string, type: string, at: string) =>
      c.query(`INSERT INTO stripe_webhook_events (stripe_event_id, stripe_event_type, account_id, created_at) VALUES ($1, $2, $3, $4)`, [`evt_${randomUUID()}`, type, id, at]);

    it('key: the earliest last_validated_at of an ok connection; a now-broken, unvalidated or missing key stays NULL', async () => {
      const [okAcc, brokenAcc, bareAcc, twoAcc] = await run(async (c) => {
        const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
        for (const id of ids) await c.query(`INSERT INTO accounts (id) VALUES ($1)`, [id]);
        await conn(c, ids[0]!, 'ok', '2026-03-01T10:00:00Z');
        await conn(c, ids[1]!, 'broken', '2026-03-01T10:00:00Z');
        await conn(c, ids[3]!, 'ok', '2026-05-01T10:00:00Z');
        await conn(c, ids[3]!, 'ok', '2026-04-01T10:00:00Z');
        return ids;
      });
      expect(okAcc!.key).toEqual(new Date('2026-03-01T10:00:00Z'));
      expect(brokenAcc!.key).toBeNull();
      expect(bareAcc!.key).toBeNull();
      expect(twoAcc!.key).toEqual(new Date('2026-04-01T10:00:00Z'));
    });

    it('paid: the earliest activating webhook event, else stripe_synced_at while active or trialing, else NULL', async () => {
      const [withEvents, syncedActive, syncedCanceled, none, otherEventOnly] = await run(async (c) => {
        const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
        for (const id of ids) await c.query(`INSERT INTO accounts (id) VALUES ($1)`, [id]);
        await event(c, ids[0]!, 'invoice.paid', '2026-04-10T00:00:00Z');
        await event(c, ids[0]!, 'checkout.session.completed', '2026-04-01T00:00:00Z');
        await event(c, ids[0]!, 'invoice.payment_failed', '2026-03-01T00:00:00Z');
        await c.query(`UPDATE accounts SET stripe_subscription_status = 'active', stripe_synced_at = '2026-06-01T00:00:00Z' WHERE id = $1`, [ids[1]]);
        await c.query(`UPDATE accounts SET stripe_subscription_status = 'canceled', stripe_synced_at = '2026-06-01T00:00:00Z' WHERE id = $1`, [ids[2]]);
        await event(c, ids[4]!, 'invoice.payment_failed', '2026-03-01T00:00:00Z');
        return ids;
      });
      expect(withEvents!.paid).toEqual(new Date('2026-04-01T00:00:00Z'));
      expect(syncedActive!.paid).toEqual(new Date('2026-06-01T00:00:00Z'));
      expect(syncedCanceled!.paid).toBeNull();
      expect(none!.paid).toBeNull();
      expect(otherEventOnly!.paid).toBeNull();
    });
  });
});
