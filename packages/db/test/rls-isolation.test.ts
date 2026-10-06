import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import {
  freshOwnIdentityFor,
  insertRowForAccount,
  seedAccount,
  TENANT_TABLES,
  type SeedRefs,
} from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

describe('RLS isolation (as app_user)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let refsA: SeedRefs;
  let refsB: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);

    refsA = await seedAccount(admin, randomUUID());
    refsB = await seedAccount(admin, randomUUID());
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
  });

  it.each(TENANT_TABLES)('SELECT on %s as tenant A never returns tenant B rows', async (table) => {
    await withTenant(appUserPool, refsA.accountId, async (client) => {
      const { rows } = await client.query<{ account_id: string }>(
        `SELECT account_id FROM ${table}`,
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.account_id).toBe(refsA.accountId);
      }
    });
  });

  it('SELECT on accounts as tenant A never returns the tenant B row', async () => {
    await withTenant(appUserPool, refsA.accountId, async (client) => {
      const { rows } = await client.query<{ id: string }>('SELECT id FROM accounts');
      expect(rows.map((r) => r.id)).toEqual([refsA.accountId]);
    });
  });

  it('SELECT with app.account_id unset returns zero rows (fail closed)', async () => {
    const client = await appUserPool.connect();
    try {
      // Deliberately no withTenant() here: app.account_id is unset on this connection.
      const { rows } = await client.query('SELECT * FROM work_items');
      expect(rows).toEqual([]);
    } finally {
      client.release();
    }
  });

  it.each(TENANT_TABLES)(
    'INSERT into %s with account_id = tenant B is rejected under a tenant A session',
    async (table) => {
      // A row that's valid in every way EXCEPT account_id: freshOwnIdentityFor
      // avoids colliding on a UNIQUE/PK constraint reused from refsB's own
      // already-seeded row, which would reject for the WRONG reason and
      // pass a message-only assertion anyway (security fix round 5
      // suggestion 4 -- this is exactly the case the reviewer found).
      await expect(
        withTenant(appUserPool, refsA.accountId, async (client) => {
          await insertRowForAccount(
            client,
            table,
            refsB.accountId,
            refsB,
            freshOwnIdentityFor(table, refsA.userId),
          );
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    },
  );

  it.each(TENANT_TABLES)(
    'UPDATE on %s re-parenting a tenant A row to account_id = tenant B is rejected',
    async (table) => {
      await expect(
        withTenant(appUserPool, refsA.accountId, async (client) => {
          await client.query(`UPDATE ${table} SET account_id = $1 WHERE account_id = $2`, [
            refsB.accountId,
            refsA.accountId,
          ]);
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    },
  );
});
