import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { insertRowForAccount, nextGhInstallationId, seedAccount, type SeedRefs } from './helpers/seed.js';

/**
 * Seeded installations must never collide on installations_gh_installation_kind_key
 * (UNIQUE gh_installation_id, app_kind) however many a suite seeds into one shared database.
 */
describe('seeded installation ids', () => {
  it('hands out distinct, safe-integer ids across many calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      const id = nextGhInstallationId();
      expect(Number.isSafeInteger(Number(id))).toBe(true);
      expect(Number(id)).toBeGreaterThan(0);
      seen.add(id);
    }
    expect(seen.size).toBe(5000);
  });

  describe('against Postgres', () => {
    let pool: Pool;
    let admin: PoolClient;
    let refs: SeedRefs;
    beforeAll(async () => {
      pool = createPool(process.env.DATABASE_URL!);
      admin = await pool.connect();
      refs = await seedAccount(admin, randomUUID());
    });
    afterAll(async () => {
      admin.release();
      await pool.end();
    });

    it('seeds 5000 installations for one account without a unique violation', async () => {
      const count = async () =>
        Number(
          (await admin.query<{ n: string }>('SELECT count(*)::text AS n FROM installations WHERE account_id = $1', [refs.accountId]))
            .rows[0]!.n,
        );
      const before = await count();
      for (let i = 0; i < 5000; i++) {
        // A fresh row identity per insert: the default would reuse refs.installationId and trip the primary key first.
        await insertRowForAccount(admin, 'installations', refs.accountId, refs, randomUUID());
      }
      expect((await count()) - before).toBe(5000);
    }, 60000);
  });
});
