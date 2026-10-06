import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * DP2 items 2 and 4 (C4, C8): app_user holds SELECT+INSERT (never UPDATE
 * or DELETE) on decision_settings, and SELECT-only (never INSERT) on
 * decision_receipts -- the receipt writer is DP3's receipt_writer role,
 * not built here. Each grant is asserted two ways: once against
 * information_schema.role_table_grants directly (so the grant list itself
 * is explicit and can't silently grow), and once by actually attempting
 * the forbidden verb as app_user and confirming it fails on privileges,
 * not on RLS content.
 */
describe('decision_settings / decision_receipts grants', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let refsA: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    // seedAccount's account_members row for refs.userId is role 'owner'
    // (see test/helpers/seed.ts) -- required here so the INSERT tests
    // below exercise the grant itself, not decision_settings' separate
    // owner/admin-only policy (covered by test/decisions-dial-write.test.ts).
    refsA = await seedAccount(admin, randomUUID());
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
  });

  describe('decision_settings (DP2 item 2, C8)', () => {
    it("app_user's grant list is exactly {SELECT, INSERT}", async () => {
      const { rows } = await admin.query<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.role_table_grants
         WHERE grantee = 'app_user' AND table_schema = 'public' AND table_name = 'decision_settings'
         ORDER BY privilege_type`,
      );
      expect(rows.map((r) => r.privilege_type)).toEqual(['INSERT', 'SELECT']);
    });

    it('app_user (as the seeded owner) can SELECT and INSERT its own rows', async () => {
      // D#7 DP2 fix round: owner_or_admin_insert now also requires
      // changed_by = app.user_id (see migrations/0400_decisions.sql), so
      // this grant-level test must set app.user_id to the SAME real owner
      // it inserts as changed_by -- the 4-arg withTenant() form, not the
      // 3-arg one this test used before the fix.
      await withTenant(appUserPool, refsA.accountId, refsA.userId, async (client) => {
        await expect(
          client.query(
            `INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, version, changed_by)
             VALUES ($1, $2, 'merge.fast-path', 'ask', 1, $3)`,
            [refsA.accountId, refsA.repoId, refsA.userId],
          ),
        ).resolves.toBeDefined();

        const { rows } = await client.query('SELECT 1 FROM decision_settings WHERE account_id = $1', [
          refsA.accountId,
        ]);
        expect(rows.length).toBeGreaterThan(0);
      });
    });

    it('app_user cannot UPDATE a decision_settings row (fails on privileges, C8)', async () => {
      await expect(
        withTenant(appUserPool, refsA.accountId, async (client) => {
          await client.query(`UPDATE decision_settings SET disposition = 'act' WHERE account_id = $1`, [
            refsA.accountId,
          ]);
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('app_user cannot DELETE a decision_settings row', async () => {
      await expect(
        withTenant(appUserPool, refsA.accountId, async (client) => {
          await client.query(`DELETE FROM decision_settings WHERE account_id = $1`, [refsA.accountId]);
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });

      const { rows } = await admin.query('SELECT 1 FROM decision_settings WHERE account_id = $1', [
        refsA.accountId,
      ]);
      expect(rows.length).toBeGreaterThan(0);
    });
  });

  describe('decision_receipts (DP2 item 4, C4)', () => {
    beforeAll(async () => {
      await admin.query(
        `INSERT INTO decision_receipts (account_id, run_id, work_item_id, decision_type, class)
         VALUES ($1, $2, $3, 'merge.fast-path', 'human_over_the_loop')`,
        [refsA.accountId, refsA.runId, refsA.workItemId],
      );
    });

    it("app_user's grant list is exactly {SELECT}", async () => {
      const { rows } = await admin.query<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.role_table_grants
         WHERE grantee = 'app_user' AND table_schema = 'public' AND table_name = 'decision_receipts'
         ORDER BY privilege_type`,
      );
      expect(rows.map((r) => r.privilege_type)).toEqual(['SELECT']);
    });

    it('app_user can SELECT its own decision_receipts rows', async () => {
      await withTenant(appUserPool, refsA.accountId, async (client) => {
        const { rows } = await client.query('SELECT 1 FROM decision_receipts WHERE account_id = $1', [
          refsA.accountId,
        ]);
        expect(rows.length).toBeGreaterThan(0);
      });
    });

    it('app_user cannot INSERT into decision_receipts -- the writer is DP3 (fails on privileges, C4)', async () => {
      await expect(
        withTenant(appUserPool, refsA.accountId, async (client) => {
          await client.query(
            `INSERT INTO decision_receipts (account_id, decision_type, class) VALUES ($1, 'merge.fast-path', 'human_over_the_loop')`,
            [refsA.accountId],
          );
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });
  });
});
