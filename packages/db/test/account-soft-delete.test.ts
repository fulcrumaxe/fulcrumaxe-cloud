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

/**
 * D#2605 H02 security fix round 4 (Team Lead decision, following the
 * round-3 finding that DELETE on accounts cascade-deleted ledger and
 * audit_log). Deletion is soft-delete only: `accounts.deleted_at`, set by
 * platform_ops, never a real DELETE (nobody -- app_user or platform_ops --
 * has DELETE on accounts at all in normal operation). A soft-deleted
 * account's billing/audit records must stay visible to platform_ops, and
 * its tenant session must go completely dark: zero rows readable or
 * writable anywhere, via account_is_active() gating every app_user policy.
 */
describe('account soft-delete', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let refsDeleted: SeedRefs;
  let refsActive: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);

    refsDeleted = await seedAccount(admin, randomUUID());
    refsActive = await seedAccount(admin, randomUUID());

    // The account under test gets soft-deleted through platform_ops's own
    // grant -- exactly the path H10 would use, not an admin/superuser
    // shortcut.
    await platformOpsPool.query('UPDATE accounts SET deleted_at = now() WHERE id = $1', [
      refsDeleted.accountId,
    ]);
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await platformOpsPool.end();
  });

  describe('half 1: platform_ops keeps full visibility for billing and audit', () => {
    it('platform_ops still sees the soft-deleted account row itself', async () => {
      const { rows } = await platformOpsPool.query<{ id: string; deleted_at: Date | null }>(
        'SELECT id, deleted_at FROM accounts WHERE id = $1',
        [refsDeleted.accountId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].deleted_at).not.toBeNull();
    });

    it('platform_ops still sees the ledger rows for a soft-deleted account (billing)', async () => {
      const { rows } = await platformOpsPool.query(
        'SELECT 1 FROM ledger WHERE account_id = $1',
        [refsDeleted.accountId],
      );
      expect(rows.length).toBeGreaterThan(0);
    });

    it('platform_ops still sees the audit_log rows for a soft-deleted account (audit)', async () => {
      const { rows } = await platformOpsPool.query(
        'SELECT 1 FROM audit_log WHERE account_id = $1',
        [refsDeleted.accountId],
      );
      expect(rows.length).toBeGreaterThan(0);
    });
  });

  describe('half 2: the tenant session goes completely dark', () => {
    it('app_user sees zero rows on accounts itself for the soft-deleted account', async () => {
      await withTenant(appUserPool, refsDeleted.accountId, async (client) => {
        const { rows } = await client.query('SELECT * FROM accounts');
        expect(rows).toEqual([]);
      });
    });

    it.each(TENANT_TABLES)('app_user sees zero rows on %s for the soft-deleted account', async (table) => {
      await withTenant(appUserPool, refsDeleted.accountId, async (client) => {
        // agent_runs has a column-level SELECT grant (0756), so a star select is refused there; `id` is enough to prove zero rows.
        const { rows } = await client.query(`SELECT ${table === 'agent_runs' ? 'id' : '*'} FROM ${table}`);
        expect(rows).toEqual([]);
      });
    });

    it.each(TENANT_TABLES)(
      'app_user cannot INSERT into %s under the soft-deleted account, even with otherwise-valid data',
      async (table) => {
        // freshOwnIdentityFor avoids colliding on a UNIQUE/PK constraint
        // reused from refsDeleted's own already-seeded row -- otherwise
        // this could reject for the wrong reason (security fix round 5
        // suggestion 4). refsActive.userId is the "spare" real user for
        // account_members's case: a different account's real member,
        // never already tied to refsDeleted's account.
        await expect(
          withTenant(appUserPool, refsDeleted.accountId, async (client) => {
            await insertRowForAccount(
              client,
              table,
              refsDeleted.accountId,
              refsDeleted,
              freshOwnIdentityFor(table, refsActive.userId),
            );
          }),
        ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      },
    );

    it('app_user cannot UPDATE an existing row under the soft-deleted account', async () => {
      await withTenant(appUserPool, refsDeleted.accountId, async (client) => {
        const { rowCount } = await client.query(
          `UPDATE model_connections SET status = 'broken' WHERE account_id = $1`,
          [refsDeleted.accountId],
        );
        // Not an error -- USING filters the row out of the UPDATE's WHERE
        // match entirely, so zero rows are touched rather than the
        // statement being rejected outright.
        expect(rowCount).toBe(0);
      });
    });

    it('the account_members-mediated users view also goes dark for the soft-deleted account', async () => {
      // Also satisfies security fix round 7 suggestion 1's request ("test
      // that a soft-deleted account's session sees no user rows through
      // that path"): member_visible now checks account_is_active
      // directly too, but as its own comment in the migration explains,
      // account_members' SELECT policy already going dark (proven
      // elsewhere in this file) meant this was already true before that
      // symmetry fix -- there's no scenario where the EXISTS below can
      // see a row account_members itself wouldn't already hide, since
      // both run as the same app_user role under the same RLS. This test
      // covers the observable behavior either way.
      await withTenant(appUserPool, refsDeleted.accountId, async (client) => {
        const { rows } = await client.query('SELECT * FROM users');
        expect(rows).toEqual([]);
      });
    });
  });

  it('sanity: an ACTIVE account is completely unaffected', async () => {
    await withTenant(appUserPool, refsActive.accountId, async (client) => {
      const { rows: accountRows } = await client.query('SELECT id FROM accounts');
      expect(accountRows).toEqual([{ id: refsActive.accountId }]);

      for (const table of TENANT_TABLES) {
        const { rows } = await client.query(`SELECT 1 FROM ${table}`);
        expect(rows.length).toBeGreaterThan(0);
      }
    });
  });
});
