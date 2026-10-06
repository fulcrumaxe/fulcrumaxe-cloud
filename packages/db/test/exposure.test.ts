import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { getAccountFeature, listAccountFeatures, writeFeatureFlip } from '../src/exposure.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#8 R1 criteria 1-4 (migrations/0611_exposure_audit.sql,
 * src/exposure.ts). `exposure_writer` has no dedicated connection string
 * in this test harness (ephemeral-pg.ts/globalSetup.ts are out of R1's
 * file scope, and the role is deliberately unreachable from anywhere a
 * sandbox or agent tool surface could resolve it -- see the migration's
 * own file header). Every write in this file goes through `admin` (the
 * ephemeral cluster's `postgres` superuser -- see globalSetup.ts) with
 * `SET ROLE exposure_writer` for exactly the one statement, then `RESET
 * ROLE` -- a superuser may always SET ROLE to any role, with no
 * additional grant needed, unlike a non-superuser CREATEROLE owner (see
 * 0001_core.sql's platform_ops `WITH SET TRUE` grant, needed there
 * precisely because that path is NOT superuser).
 */
describe('account_features (D#8 R1 criteria 1-4)', () => {
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

  /** Writes one account_features row as exposure_writer, via the superuser admin connection (see file header). */
  async function writeAsExposureWriter(
    accountId: string,
    featureKey: string,
    state: 'on' | 'off',
    source: 'customer' | 'platform' | 'product_default',
    decidedByUserId: string,
  ): Promise<void> {
    await admin.query('SET ROLE exposure_writer');
    try {
      await admin.query(
        `INSERT INTO account_features (account_id, feature_key, state, source, decided_by_user_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [accountId, featureKey, state, source, decidedByUserId],
      );
    } finally {
      await admin.query('RESET ROLE');
    }
  }

  describe('criterion 1: shape, CHECKs, RLS InitPlan predicate', () => {
    it('has exactly the column shape from criterion 1', async () => {
      const { rows } = await admin.query<{
        column_name: string;
        data_type: string;
        is_nullable: 'YES' | 'NO';
      }>(
        `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'account_features'
         ORDER BY column_name`,
      );
      const byName = new Map(rows.map((r) => [r.column_name, r]));
      expect(byName.get('id')?.data_type).toBe('uuid');
      expect(byName.get('account_id')?.data_type).toBe('uuid');
      expect(byName.get('feature_key')?.data_type).toBe('text');
      expect(byName.get('state')?.data_type).toBe('text');
      expect(byName.get('source')?.data_type).toBe('text');
      expect(byName.get('decided_by_user_id')?.data_type).toBe('uuid');
      expect(byName.get('decided_by_user_id')?.is_nullable).toBe('NO');
      expect(byName.get('decided_at')?.data_type).toBe('timestamp with time zone');
      expect(byName.get('created_at')?.data_type).toBe('timestamp with time zone');
      expect(byName.get('updated_at')?.data_type).toBe('timestamp with time zone');
      expect(rows.map((r) => r.column_name).sort()).toEqual(
        [
          'account_id',
          'created_at',
          'decided_at',
          'decided_by_user_id',
          'feature_key',
          'id',
          'source',
          'state',
          'updated_at',
        ].sort(),
      );
    });

    it('UNIQUE (account_id, feature_key): a second row for the same key is rejected', async () => {
      await writeAsExposureWriter(refsA.accountId, 'dup-check', 'on', 'customer', refsA.userId);
      await expect(
        admin.query(
          `INSERT INTO account_features (account_id, feature_key, state, source, decided_by_user_id)
           VALUES ($1, 'dup-check', 'off', 'platform', $2)`,
          [refsA.accountId, refsA.userId],
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
    });

    it("state rejects a value outside 'on'/'off'", async () => {
      await expect(
        admin.query(
          `INSERT INTO account_features (account_id, feature_key, state, source, decided_by_user_id)
           VALUES ($1, 'bad-state', 'maybe', 'customer', $2)`,
          [refsA.accountId, refsA.userId],
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });

    it("source rejects a value outside customer/platform/product_default", async () => {
      await expect(
        admin.query(
          `INSERT INTO account_features (account_id, feature_key, state, source, decided_by_user_id)
           VALUES ($1, 'bad-source', 'on', 'reseller', $2)`,
          [refsA.accountId, refsA.userId],
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });

    it('RLS is enabled and forced', async () => {
      const { rows } = await admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'account_features'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].relrowsecurity).toBe(true);
      expect(rows[0].relforcerowsecurity).toBe(true);
    });

    it('the app_user SELECT policy uses the InitPlan predicate form verbatim, not account_is_active(account_id)', async () => {
      const { rows } = await admin.query<{ qual: string | null }>(
        `SELECT qual FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'account_features' AND policyname = 'tenant_isolation_select'`,
      );
      expect(rows).toHaveLength(1);
      const qual = rows[0].qual ?? '';
      // The InitPlan form: account_is_active() called on the SESSION
      // SETTING, wrapped in a scalar subquery -- not on the row's own
      // account_id column (the per-row form measured 25x slower, see the
      // migration's file header and 0001_core.sql's account_is_active()
      // comment).
      expect(qual).toMatch(/\(\s*SELECT\s+account_is_active\(/i);
      expect(qual).not.toMatch(/account_is_active\(\s*account_id\s*\)/i);
    });
  });

  describe('criteria 2-3: grant matrix -- exactly {exposure_writer} for INSERT/UPDATE, app_user is SELECT-only', () => {
    it("app_user's grant list is exactly {SELECT}", async () => {
      const { rows } = await admin.query<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.role_table_grants
         WHERE grantee = 'app_user' AND table_schema = 'public' AND table_name = 'account_features'
         ORDER BY privilege_type`,
      );
      expect(rows.map((r) => r.privilege_type)).toEqual(['SELECT']);
    });

    it('the set of roles holding INSERT, UPDATE or DELETE is exactly {exposure_writer}', async () => {
      // Scoped to the known application roles, the same allowlist
      // neon-shape-catalog.sql itself uses (grantee IN ('app_user',
      // 'platform_ops', 'partner_user')) -- information_schema.role_table_
      // grants also reports the table's OWNER (the migration/admin role:
      // `postgres` in this ephemeral cluster, `fx_migrator` under the
      // Neon shape) as implicitly holding every privilege, which is
      // correct Postgres behaviour and not part of what R1 criterion 3 is
      // asking about.
      const { rows } = await admin.query<{ grantee: string; privilege_type: string }>(
        `SELECT DISTINCT grantee, privilege_type FROM information_schema.role_table_grants
         WHERE table_schema = 'public' AND table_name = 'account_features'
           AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE')
           AND grantee IN ('app_user', 'platform_ops', 'partner_user', 'exposure_writer')`,
      );
      const grantees = new Set(rows.map((r) => r.grantee));
      expect(grantees).toEqual(new Set(['exposure_writer']));
      expect(rows.map((r) => r.privilege_type).sort()).toEqual(['INSERT', 'UPDATE']);
      expect(rows.some((r) => r.privilege_type === 'DELETE')).toBe(false);
    });

    it('app_user cannot INSERT into account_features (fails on privileges)', async () => {
      await expect(
        withTenant(appUserPool, refsA.accountId, refsA.userId, async (client) => {
          await client.query(
            `INSERT INTO account_features (account_id, feature_key, state, source, decided_by_user_id)
             VALUES ($1, 'app-user-insert-attempt', 'on', 'customer', $2)`,
            [refsA.accountId, refsA.userId],
          );
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('app_user cannot UPDATE an account_features row (fails on privileges)', async () => {
      await writeAsExposureWriter(refsA.accountId, 'app-user-update-attempt', 'on', 'customer', refsA.userId);
      await expect(
        withTenant(appUserPool, refsA.accountId, async (client) => {
          await client.query(
            `UPDATE account_features SET state = 'off' WHERE account_id = $1 AND feature_key = 'app-user-update-attempt'`,
            [refsA.accountId],
          );
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('non-vacuity: the identical write app_user was refused succeeds as exposure_writer', async () => {
      // Same table, same content shape as the "app_user cannot INSERT"
      // test above -- proves that test failed on privileges specifically,
      // not because the content itself was somehow invalid.
      await expect(
        writeAsExposureWriter(refsA.accountId, 'non-vacuity-check', 'on', 'customer', refsA.userId),
      ).resolves.toBeUndefined();
      const { rows } = await admin.query(
        `SELECT state FROM account_features WHERE account_id = $1 AND feature_key = 'non-vacuity-check'`,
        [refsA.accountId],
      );
      expect(rows).toEqual([{ state: 'on' }]);
    });

    it('app_user can SELECT its own account_features rows', async () => {
      await writeAsExposureWriter(refsA.accountId, 'select-check', 'on', 'customer', refsA.userId);
      await withTenant(appUserPool, refsA.accountId, async (client) => {
        const feature = await getAccountFeature(client, 'select-check');
        expect(feature?.state).toBe('on');
        expect(feature?.accountId).toBe(refsA.accountId);

        const all = await listAccountFeatures(client);
        expect(all.some((f) => f.featureKey === 'select-check')).toBe(true);
      });
    });

    it('a feature never decided for this account reads back null', async () => {
      await withTenant(appUserPool, refsA.accountId, async (client) => {
        expect(await getAccountFeature(client, 'never-decided-' + randomUUID())).toBeNull();
      });
    });
  });

  describe('criterion 4: decided_by_user_id is derived from the session, never client input', () => {
    it('writeFeatureFlip() ignores a forged decidedByUserId in the payload and stores ctx.principal', async () => {
      await admin.query('SET ROLE exposure_writer');
      try {
        const forgedInput = {
          accountId: refsA.accountId,
          featureKey: 'forged-actor-check',
          state: 'on',
          source: 'customer',
          // Not part of WriteFeatureFlipInput's type -- simulates a
          // malicious request body smuggling an extra field. TypeScript
          // would reject this as excess-property on a literal passed
          // directly, so it's cast through `as` to model "a raw object
          // parsed from request JSON", exactly the shape a real HTTP
          // handler would receive before validation.
          decidedByUserId: randomUUID(),
        } as unknown as Parameters<typeof writeFeatureFlip>[1];

        // `admin` (a single checked-out PoolClient, not adminPool the
        // Pool) so the SET ROLE issued above actually applies to the
        // connection writeFeatureFlip's INSERT runs on -- see
        // WriteFeatureFlipContext's own comment in exposure.ts.
        const result = await writeFeatureFlip(
          { pool: admin, principal: refsA.userId },
          forgedInput,
        );
        expect(result.decidedByUserId).toBe(refsA.userId);
        expect(result.decidedByUserId).not.toBe(
          (forgedInput as unknown as { decidedByUserId: string }).decidedByUserId,
        );

        const { rows } = await admin.query<{ decided_by_user_id: string }>(
          `SELECT decided_by_user_id FROM account_features WHERE account_id = $1 AND feature_key = 'forged-actor-check'`,
          [refsA.accountId],
        );
        expect(rows[0]?.decided_by_user_id).toBe(refsA.userId);
      } finally {
        await admin.query('RESET ROLE');
      }
    });

    it('writeFeatureFlip() upserts: a second flip on the same key updates in place, not a second row', async () => {
      await admin.query('SET ROLE exposure_writer');
      try {
        await writeFeatureFlip(
          { pool: admin, principal: refsA.userId },
          { accountId: refsA.accountId, featureKey: 'upsert-check', state: 'off', source: 'customer' },
        );
        const second = await writeFeatureFlip(
          { pool: admin, principal: refsA.userId },
          { accountId: refsA.accountId, featureKey: 'upsert-check', state: 'on', source: 'platform' },
        );
        expect(second.state).toBe('on');
        expect(second.source).toBe('platform');

        const { rows } = await admin.query(
          `SELECT state, source FROM account_features WHERE account_id = $1 AND feature_key = 'upsert-check'`,
          [refsA.accountId],
        );
        expect(rows).toEqual([{ state: 'on', source: 'platform' }]);
      } finally {
        await admin.query('RESET ROLE');
      }
    });
  });
});
