import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';
import { findRlsViolations } from '../src/rlsInventory.js';

/** D#2 H15b-1 (C39 ruling (b)): `parked_work_items` tenancy, grants and replay safety. */
describe('parked_work_items (D#2 H15b-1)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let partnerUserPool: Pool;
  let platformOpsPool: Pool;
  let refsA: SeedRefs;
  let refsB: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    partnerUserPool = createPool(process.env.DATABASE_URL_PARTNER_USER!);
    platformOpsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    refsA = await seedAccount(admin, randomUUID());
    refsB = await seedAccount(admin, randomUUID());
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await partnerUserPool.end();
    await platformOpsPool.end();
  });

  const park = (refs: SeedRefs, tenant: SeedRefs = refs, reason = 'external_no_discussion') =>
    withTenant(appUserPool, tenant.accountId, (client) =>
      client.query(
        `INSERT INTO parked_work_items (account_id, work_item_id, reason) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING RETURNING id`,
        [refs.accountId, refs.workItemId, reason],
      ),
    );

  it('a second insert of the same (account, work item, reason) is a no-op: one row', async () => {
    const first = await park(refsA);
    const second = await park(refsA);
    expect(first.rowCount).toBe(1);
    expect(second.rowCount).toBe(0);
    const { rows } = await admin.query(
      `SELECT count(*)::int AS n FROM parked_work_items WHERE account_id = $1 AND work_item_id = $2`,
      [refsA.accountId, refsA.workItemId],
    );
    expect(rows[0].n).toBe(1);
  });

  it('a plain duplicate INSERT (no ON CONFLICT) fails 23505', async () => {
    await park(refsB);
    await expect(
      withTenant(appUserPool, refsB.accountId, (client) =>
        client.query(`INSERT INTO parked_work_items (account_id, work_item_id, reason) VALUES ($1, $2, 'external_no_discussion')`, [
          refsB.accountId,
          refsB.workItemId,
        ]),
      ),
    ).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
  });

  it('an unknown reason is rejected (CHECK 23514)', async () => {
    await expect(park(refsA, refsA, 'because')).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
  });

  it('the row must reference a work item of the same account (composite FK 23503)', async () => {
    await expect(
      admin.query(`INSERT INTO parked_work_items (account_id, work_item_id, reason) VALUES ($1, $2, 'external_no_discussion')`, [
        refsA.accountId,
        refsB.workItemId,
      ]),
    ).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
  });

  it('RLS is enabled and forced, and there is no free-text column', async () => {
    const { rows } = await admin.query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'parked_work_items'::regclass`,
    );
    expect(rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const cols = await admin.query(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'parked_work_items' ORDER BY ordinal_position`,
    );
    expect(cols.rows.map((c) => c.column_name)).toEqual(['id', 'account_id', 'work_item_id', 'reason', 'created_at']);
    expect(cols.rows.filter((c) => c.data_type === 'text').map((c) => c.column_name)).toEqual(['reason']);
  });

  it("the tenant_isolation policy is identical to work_item_transitions'", async () => {
    const { rows } = await admin.query<{ tablename: string; qual: string; with_check: string }>(
      `SELECT tablename, qual, with_check FROM pg_policies
        WHERE schemaname = 'public' AND policyname = 'tenant_isolation'
          AND tablename IN ('parked_work_items', 'work_item_transitions')`,
    );
    const by = new Map(rows.map((r) => [r.tablename, r]));
    expect(by.get('parked_work_items')).toBeDefined();
    expect(by.get('parked_work_items')!.qual).toBe(by.get('work_item_transitions')!.qual);
    expect(by.get('parked_work_items')!.with_check).toBe(by.get('work_item_transitions')!.with_check);
  });

  it('app_user holds exactly SELECT and INSERT; UPDATE and DELETE fail 42501', async () => {
    const { rows } = await admin.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_schema = 'public' AND table_name = 'parked_work_items' AND grantee = 'app_user'`,
    );
    expect(new Set(rows.map((r) => r.privilege_type))).toEqual(new Set(['SELECT', 'INSERT']));
    await expect(
      withTenant(appUserPool, refsA.accountId, (c) => c.query(`UPDATE parked_work_items SET reason = reason`)),
    ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    await expect(
      withTenant(appUserPool, refsA.accountId, (c) => c.query(`DELETE FROM parked_work_items`)),
    ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
  });

  it('partner_user and platform_ops have no access (42501)', async () => {
    for (const pool of [partnerUserPool, platformOpsPool]) {
      const client = await pool.connect();
      try {
        await expect(client.query('SELECT 1 FROM parked_work_items')).rejects.toMatchObject({
          code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
        });
      } finally {
        client.release();
      }
    }
  });

  it("two tenants, live: A sees only A's row, B only B's; a cross-tenant INSERT is refused", async () => {
    await park(refsA);
    await park(refsB);
    const seen = async (r: SeedRefs) =>
      withTenant(appUserPool, r.accountId, async (c) =>
        (await c.query<{ account_id: string }>('SELECT account_id FROM parked_work_items')).rows.map((x) => x.account_id),
      );
    expect(await seen(refsA)).toEqual([refsA.accountId]);
    expect(await seen(refsB)).toEqual([refsB.accountId]);
    // A tenant-A session writing a row for B fails the WITH CHECK.
    await expect(park(refsB, refsA)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
  });

  it('findRlsViolations returns [] on the migrated schema', async () => {
    expect(await findRlsViolations(admin)).toEqual([]);
  });
});
