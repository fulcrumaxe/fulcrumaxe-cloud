import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { CROSS_TENANT_FK_CASES, seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#2605 H02 security fix round 2, item 1 (CWE-639): every child FK that
 * used to be a plain `REFERENCES parent (id)` is now composite,
 * `FOREIGN KEY (account_id, fk) REFERENCES parent (account_id, id)`. This
 * proves the constraint itself -- not RLS -- rejects a cross-tenant parent
 * id.
 *
 * Deliberately run as the ADMIN (superuser) connection, which bypasses RLS
 * entirely: the original vulnerability was that the FK constraint check
 * ALSO runs with elevated internal privilege and bypasses RLS, so a fix
 * that only worked "as app_user, because RLS also happens to catch it"
 * would leave the real bug (the FK itself accepting any tenant's id)
 * unproven. Running as admin isolates the FK constraint as the thing doing
 * the rejecting.
 */
describe('cross-tenant foreign keys are rejected (CWE-639)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let refsA: SeedRefs;
  let refsB: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    refsA = await seedAccount(admin, randomUUID());
    refsB = await seedAccount(admin, randomUUID());
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
  });

  it.each(CROSS_TENANT_FK_CASES)(
    '$label: tenant A pointing at tenant B\'s parent id is rejected',
    async ({ foreignRef, insert }) => {
      const foreignId = foreignRef(refsB);
      const { sql, params } = insert(refsA.accountId, refsA, foreignId);
      await expect(admin.query(sql, params)).rejects.toMatchObject({
        code: PG_ERROR.FOREIGN_KEY_VIOLATION,
      });
    },
  );

  it('sanity: the SAME insert shape succeeds when it points at its OWN tenant\'s parent id', async () => {
    // Proves the rejection above is specifically about the cross-tenant id,
    // not a broken query -- the identical statement shape against A's own
    // run_id succeeds.
    const { sql, params } = CROSS_TENANT_FK_CASES[0].insert(
      refsA.accountId,
      refsA,
      refsA.runId,
    );
    await expect(admin.query(sql, params)).resolves.toBeDefined();
  });
});
