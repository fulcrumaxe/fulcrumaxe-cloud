import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { findRlsViolations } from '../src/rlsInventory.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

const BOARD_TABLES = ['board_repo_settings', 'board_listings', 'task_claims', 'claim_attestations', 'claim_fundings'] as const;

// D#70 BRD-1a, 0657: 1a-2 (RLS) and 1a-5 (isolation, with C-1 write refusal).
describe('migration 0657: board tables are RLS-enabled, forced and tenant-isolated', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;

  async function seedTenant(): Promise<SeedRefs> {
    const refs = await seedAccount(admin, randomUUID());
    const listingId = randomUUID();
    const claimId = randomUUID();
    await admin.query('INSERT INTO board_repo_settings (account_id, repo_id) VALUES ($1, $2)', [refs.accountId, refs.repoId]);
    await admin.query(
      `INSERT INTO board_listings (account_id, id, work_item_id, repo_id, visibility, spec_sha256, spec_snapshot, file_scope)
       VALUES ($1, $2, $3, $4, 'team', 'x', 's', ARRAY['a'])`,
      [refs.accountId, listingId, refs.workItemId, refs.repoId],
    );
    await admin.query(
      `INSERT INTO task_claims (account_id, id, listing_id, claimant_user_id, claimant_was_member, payer_account_ref,
                                funding_ref, spec_sha256, expires_at)
       VALUES ($1, $2, $3, $4, true, $1, $5, 'x', now() + interval '1 day')`,
      [refs.accountId, claimId, listingId, refs.userId, randomUUID()],
    );
    await admin.query(
      `INSERT INTO claim_attestations (account_id, claim_id, head_sha, base_sha, kid, envelope) VALUES ($1, $2, 'h', 'b', 'k', '{}')`,
      [refs.accountId, claimId],
    );
    await admin.query(
      `INSERT INTO claim_fundings (account_id, claim_ref, listing_ref, kind, cap_model_usd, cap_compute_usd)
       VALUES ($1, $2, $3, 'self', 1, 1)`,
      [refs.accountId, claimId, listingId],
    );
    return refs;
  }

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    a = await seedTenant();
    b = await seedTenant();
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
  });

  it('1a-2: the RLS inventory reports nothing, and each new table has RLS enabled and forced', async () => {
    expect(await findRlsViolations(admin)).toEqual([]);
    const { rows } = await admin.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1) ORDER BY relname`,
      [[...BOARD_TABLES]],
    );
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.relrowsecurity, row.relname).toBe(true);
      expect(row.relforcerowsecurity, row.relname).toBe(true);
    }
  });

  it.each(BOARD_TABLES)('1a-5: as app_user in tenant A, %s shows A its own row and none of B', async (table) => {
    const seen = await withTenant(appUserPool, a.accountId, a.userId, (c) =>
      c.query<{ account_id: string }>(`SELECT account_id FROM ${table}`),
    );
    expect(seen.rows.map((r) => r.account_id)).toEqual([a.accountId]);
  });

  it.each(['board_repo_settings', 'board_listings'])(
    '1a-5: UPDATE and DELETE of B rows in %s affect 0 rows',
    async (table) => {
      const [upd, del] = await withTenant(appUserPool, a.accountId, a.userId, async (c) => [
        await c.query(`UPDATE ${table} SET updated_at = now() WHERE account_id = $1`, [b.accountId]),
        await c.query(`DELETE FROM ${table} WHERE account_id = $1`, [b.accountId]),
      ]);
      expect(upd!.rowCount).toBe(0);
      expect(del!.rowCount).toBe(0);
      const { rows } = await admin.query(`SELECT 1 FROM ${table} WHERE account_id = $1`, [b.accountId]);
      expect(rows).toHaveLength(1);
    },
  );

  it.each(['task_claims', 'claim_attestations', 'claim_fundings'])(
    '1a-5 (C-1): INSERT, UPDATE and DELETE on %s fail with 42501 for B rows and for A own rows',
    async (table) => {
      for (const owner of [a.accountId, b.accountId]) {
        for (const sql of [
          `UPDATE ${table} SET account_id = account_id WHERE account_id = $1`,
          `DELETE FROM ${table} WHERE account_id = $1`,
          `INSERT INTO ${table} SELECT * FROM ${table} WHERE account_id = $1`,
        ]) {
          await expect(
            withTenant(appUserPool, a.accountId, a.userId, (c) => c.query(sql, [owner])),
            `${table} ${sql} on ${owner === a.accountId ? 'A' : 'B'}`,
          ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
        }
      }
    },
  );
});
