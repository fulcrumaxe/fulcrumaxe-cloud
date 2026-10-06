import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#2605 H02 security fix round 7 (ERROR, caught by code review after five
 * security rounds): app_user held SELECT, INSERT, UPDATE, DELETE on both
 * `ledger` and `audit_log`. Rounds 3 and 4 made sure DELETING AN ACCOUNT
 * couldn't erase either -- the file's own comments say "a tenant must not
 * be able to erase the record of what it spent or what it did" -- but a
 * live tenant session never needed to delete an account to erase them: it
 * could just `DELETE FROM ledger WHERE account_id = <its own id>`, or
 * rewrite a `usd` value with a plain UPDATE, with no RLS bypass and no
 * account deletion involved. RLS was never the gap; the base GRANT was.
 *
 * app_user got SELECT, INSERT only on both tables at that point. Nothing
 * in the Spec needs a tenant to update or delete either: H05 settles
 * runs by INSERTing ledger rows, H12 writes audit rows on setting
 * changes -- both are appends, never edits.
 *
 * D#76: app_user's INSERT on `audit_log` specifically is gone too now --
 * not just UPDATE/DELETE. The #54 and #53 findings showed INSERT alone
 * was enough to forge actor/account_id/created_at on any row app_user
 * could otherwise legitimately write, so the append itself moved behind
 * `audit_write()`/`audit_write_system()` (migrations/
 * 0008_audit_log_append_only.sql), SECURITY DEFINER functions that stamp
 * those columns themselves rather than trusting the caller. `ledger`
 * is unaffected -- its own INSERT grant, and the reasoning above for
 * keeping it, both stand unchanged.
 */
describe('ledger/audit_log privileges: append-only for app_user', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let refsA: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    refsA = await seedAccount(admin, randomUUID());
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
  });

  describe('ledger', () => {
    it('app_user can SELECT its own ledger rows', async () => {
      await withTenant(appUserPool, refsA.accountId, async (client) => {
        const { rows } = await client.query('SELECT 1 FROM ledger WHERE account_id = $1', [
          refsA.accountId,
        ]);
        expect(rows.length).toBeGreaterThan(0);
      });
    });

    it('app_user can INSERT a new ledger row', async () => {
      await withTenant(appUserPool, refsA.accountId, async (client) => {
        await expect(
          client.query(
            `INSERT INTO ledger (account_id, kind, source, usd) VALUES ($1, 'model', 'customer_gateway', 1.23)`,
            [refsA.accountId],
          ),
        ).resolves.toBeDefined();
      });
    });

    it('app_user cannot UPDATE its own ledger row (e.g. rewriting usd)', async () => {
      await expect(
        withTenant(appUserPool, refsA.accountId, async (client) => {
          await client.query(`UPDATE ledger SET usd = 0 WHERE account_id = $1`, [
            refsA.accountId,
          ]);
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('app_user cannot DELETE its own ledger row', async () => {
      await expect(
        withTenant(appUserPool, refsA.accountId, async (client) => {
          await client.query(`DELETE FROM ledger WHERE account_id = $1`, [refsA.accountId]);
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });

      // Confirms the DELETE genuinely never happened.
      const { rows } = await admin.query('SELECT 1 FROM ledger WHERE account_id = $1', [
        refsA.accountId,
      ]);
      expect(rows.length).toBeGreaterThan(0);
    });
  });

  describe('audit_log', () => {
    it('app_user can SELECT its own audit_log rows', async () => {
      await withTenant(appUserPool, refsA.accountId, async (client) => {
        const { rows } = await client.query('SELECT 1 FROM audit_log WHERE account_id = $1', [
          refsA.accountId,
        ]);
        expect(rows.length).toBeGreaterThan(0);
      });
    });

    it('app_user CANNOT INSERT a raw audit_log row -- D#76 revoked the grant entirely; writes go through audit_write() instead', async () => {
      const { rows: before } = await admin.query('SELECT count(*)::int AS n FROM audit_log WHERE account_id = $1', [
        refsA.accountId,
      ]);
      await expect(
        withTenant(appUserPool, refsA.accountId, async (client) => {
          await client.query(`INSERT INTO audit_log (account_id, action) VALUES ($1, 'test')`, [
            refsA.accountId,
          ]);
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      const { rows: after } = await admin.query('SELECT count(*)::int AS n FROM audit_log WHERE account_id = $1', [
        refsA.accountId,
      ]);
      expect(after[0].n).toBe(before[0].n);
    });

    it('app_user cannot UPDATE its own audit_log row', async () => {
      await expect(
        withTenant(appUserPool, refsA.accountId, async (client) => {
          await client.query(`UPDATE audit_log SET action = 'rewritten' WHERE account_id = $1`, [
            refsA.accountId,
          ]);
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('app_user cannot DELETE its own audit_log row', async () => {
      await expect(
        withTenant(appUserPool, refsA.accountId, async (client) => {
          await client.query(`DELETE FROM audit_log WHERE account_id = $1`, [refsA.accountId]);
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });

      // Confirms the DELETE genuinely never happened.
      const { rows } = await admin.query('SELECT 1 FROM audit_log WHERE account_id = $1', [
        refsA.accountId,
      ]);
      expect(rows.length).toBeGreaterThan(0);
    });
  });
});
