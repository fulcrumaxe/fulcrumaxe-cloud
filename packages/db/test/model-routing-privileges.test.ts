import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../src/pool.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * Code review suggestion (non-blocking) on PR #88: no test connects as
 * app_user to prove INSERT/UPDATE/DELETE on routing_tables/routing_rows
 * are rejected -- model-routing-schema.test.ts only exercises the admin
 * pool. routing_tables and routing_rows are platform-wide (see
 * packages/db/src/platformWideTables.ts), not tenant rows, so there is no
 * account_id to scope these through withTenant() -- app_user is queried
 * directly, in the same pattern test/ledger-audit-log-privileges.test.ts
 * uses for its grant checks.
 */
describe('routing_tables / routing_rows privileges: read-only for app_user', () => {
  let appUserPool: Pool;

  beforeAll(() => {
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
  });

  afterAll(async () => {
    await appUserPool.end();
  });

  describe('routing_tables', () => {
    it('app_user can SELECT', async () => {
      const { rows } = await appUserPool.query('SELECT version FROM routing_tables');
      expect(rows.length).toBeGreaterThan(0);
    });

    it('app_user cannot INSERT', async () => {
      await expect(
        appUserPool.query(
          "INSERT INTO routing_tables (version, status, source) VALUES (900001, 'proposed', 'cost_analyst')",
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('app_user cannot UPDATE', async () => {
      await expect(
        appUserPool.query("UPDATE routing_tables SET rejection_reason = 'tampered' WHERE version = 1"),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('app_user cannot DELETE', async () => {
      await expect(
        appUserPool.query('DELETE FROM routing_tables WHERE version = 1'),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });
  });

  describe('routing_rows', () => {
    it('app_user can SELECT', async () => {
      const { rows } = await appUserPool.query('SELECT id FROM routing_rows WHERE table_version = 1');
      expect(rows.length).toBeGreaterThan(0);
    });

    it('app_user cannot INSERT', async () => {
      await expect(
        appUserPool.query(
          "INSERT INTO routing_rows (table_version, role, size, model, rationale) VALUES (1, 'executor', 'Small', 'opus-5', 'privilege probe')",
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('app_user cannot UPDATE', async () => {
      await expect(
        appUserPool.query(
          "UPDATE routing_rows SET model = 'haiku-4.5' WHERE table_version = 1 AND role = 'security-reviewer'",
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('app_user cannot DELETE', async () => {
      await expect(
        appUserPool.query("DELETE FROM routing_rows WHERE table_version = 1 AND role = 'executor'"),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });
  });
});
