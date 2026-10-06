import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * DP3a-2 .. 3a-6 (D#7 DP-C3): decision_receipt_write() is the only way to
 * write a durable receipt. "As the invoker" calls run on a LOGIN that is a
 * member of app_user AND receipt_writer_invoker (the test cluster's
 * stand-in for the production receipt login, which is never the runner's).
 */
const INVOKER_LOGIN = 'fx_receipt_invoker_test';
const WRITE_SQL = `SELECT decision_receipt_write($1::text, $2::text, $3::text, $4::text, $5::integer,
                                                   $6::jsonb, $7::uuid, $8::uuid, $9::integer) AS id`;
const DIRECT_INSERT_SQL = `INSERT INTO decision_receipts
  (account_id, decision_type, class, chosen, rejected_alternative, dial_version, input_trust_classes, actor, catalogue_version)
  VALUES ($1, 'merge', 'human_over_the_loop', 'a', 'b', 1, '[]'::jsonb, 'forged', 1)`;

type Args = { cls?: string; run?: string | null; workItem?: string | null; catalogue?: number | null };

describe('decision_receipt_write (0663)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let invokerPool: Pool;
  let refs: SeedRefs;
  let other: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    await admin.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${INVOKER_LOGIN}') THEN
          CREATE ROLE ${INVOKER_LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        END IF;
      END $$`);
    await admin.query(`GRANT app_user, receipt_writer_invoker TO ${INVOKER_LOGIN}`);
    const u = new URL(process.env.DATABASE_URL_APP_USER!);
    u.username = INVOKER_LOGIN;
    u.password = '';
    invokerPool = createPool(u.toString());
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    refs = await seedAccount(admin, randomUUID());
    other = await seedAccount(admin, randomUUID());
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await invokerPool.end();
  });

  function write(pool: Pool, tenant: SeedRefs, user: string | undefined, a: Args = {}): Promise<string> {
    const body = async (c: PoolClient): Promise<string> => {
      const { rows } = await c.query<{ id: string }>(WRITE_SQL, [
        a.cls ?? 'human_over_the_loop',
        'merge',
        'merge it',
        'wait',
        3,
        JSON.stringify(['trusted']),
        a.workItem === undefined ? null : a.workItem,
        a.run === undefined ? null : a.run,
        a.catalogue === undefined ? 1 : a.catalogue,
      ]);
      return rows[0]!.id;
    };
    return user === undefined ? withTenant(pool, tenant.accountId, body) : withTenant(pool, tenant.accountId, user, body);
  }

  const readBack = async (id: string) =>
    (await admin.query(`SELECT * FROM decision_receipts WHERE id = $1`, [id])).rows[0];

  describe('3a-2: the definer', () => {
    it('is SECURITY DEFINER, owned by receipt_writer, search_path pinned, EXECUTE for the invoker only', async () => {
      const { rows } = await admin.query(
        `SELECT p.prosecdef, pg_get_userbyid(p.proowner) AS owner, p.proconfig,
                (SELECT array_agg(DISTINCT pg_get_userbyid(a.grantee)::text)
                   FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner) AS grantees
           FROM pg_proc p WHERE p.proname = 'decision_receipt_write'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].prosecdef).toBe(true);
      expect(rows[0].owner).toBe('receipt_writer');
      expect(rows[0].proconfig).toEqual(['search_path=pg_catalog, public, pg_temp']);
      expect(rows[0].grantees).toEqual(['receipt_writer_invoker']);
    });

    it('takes no parameter named like actor, user or account', async () => {
      const { rows } = await admin.query<{ name: string }>(
        `SELECT unnest(proargnames) AS name FROM pg_proc WHERE proname = 'decision_receipt_write'`,
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect(r.name).not.toMatch(/actor|user|account/i);
    });

    it('inserts one row carrying exactly the content it was given', async () => {
      const id = await write(invokerPool, refs, refs.userId, { run: refs.runId, workItem: refs.workItemId });
      const row = await readBack(id);
      expect(row).toMatchObject({
        account_id: refs.accountId,
        run_id: refs.runId,
        work_item_id: refs.workItemId,
        decision_type: 'merge',
        class: 'human_over_the_loop',
        chosen: 'merge it',
        rejected_alternative: 'wait',
        dial_version: 3,
        input_trust_classes: ['trusted'],
        catalogue_version: 1,
      });
    });

    it('refuses class 1 with a named error', async () => {
      await expect(write(invokerPool, refs, refs.userId, { cls: 'automated_with_monitoring' })).rejects.toThrow(
        /receipt_class1_not_durable/,
      );
    });
  });

  describe('3a-3: actor and tenant come from the session (DP-C3d)', () => {
    it('reads back the session user as actor', async () => {
      const id = await write(invokerPool, refs, refs.userId);
      expect((await readBack(id)).actor).toBe(refs.userId);
    });

    it("reads back 'policy' when the session has no user", async () => {
      const id = await write(invokerPool, refs, undefined);
      expect((await readBack(id)).actor).toBe('policy');
    });

    it('refuses a user who is not a member of the tenant account', async () => {
      await expect(write(invokerPool, refs, other.userId)).rejects.toThrow(/receipt_actor_not_member/);
    });

    it('refuses a call with no tenant', async () => {
      const c = await invokerPool.connect();
      try {
        await expect(
          c.query(WRITE_SQL, ['human_over_the_loop', 'merge', 'a', 'b', 1, '[]', null, null, 1]),
        ).rejects.toThrow(/receipt_no_tenant/);
      } finally {
        c.release();
      }
    });

    it("writes to the session's tenant, so another tenant's run cannot be named", async () => {
      await expect(write(invokerPool, refs, refs.userId, { run: other.runId })).rejects.toMatchObject({
        code: PG_ERROR.FOREIGN_KEY_VIOLATION,
      });
    });
  });

  describe('3a-4: catalogue_version (DP-C3b)', () => {
    it('refuses NULL with a named error', async () => {
      await expect(write(invokerPool, refs, refs.userId, { catalogue: null })).rejects.toThrow(
        /receipt_missing_catalogue_version/,
      );
    });

    it('the column CHECK refuses a value below 1', async () => {
      await expect(write(invokerPool, refs, refs.userId, { catalogue: 0 })).rejects.toMatchObject({
        code: PG_ERROR.CHECK_VIOLATION,
      });
    });
  });

  describe('3a-5: no other path in (criterion 7, database half)', () => {
    it('a direct INSERT as app_user inside withTenant fails with 42501', async () => {
      await expect(
        withTenant(appUserPool, refs.accountId, refs.userId, (c) => c.query(DIRECT_INSERT_SQL, [refs.accountId])),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('a direct INSERT on the invoker login (member of app_user) also fails with 42501', async () => {
      await expect(
        withTenant(invokerPool, refs.accountId, refs.userId, (c) => c.query(DIRECT_INSERT_SQL, [refs.accountId])),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('the same content succeeds through the definer on the invoker login', async () => {
      const id = await write(invokerPool, refs, refs.userId);
      expect((await readBack(id)).chosen).toBe('merge it');
    });

    it('the same call as a plain app_user login fails on EXECUTE with 42501', async () => {
      await expect(write(appUserPool, refs, refs.userId)).rejects.toMatchObject({
        code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
      });
    });
  });

  describe('3a-6: C5 survival', () => {
    it('deleting the run leaves the receipt in place with run_id NULL', async () => {
      const seeded = await seedAccount(admin, randomUUID());
      const id = await write(invokerPool, seeded, seeded.userId, { run: seeded.runId });
      expect((await readBack(id)).run_id).toBe(seeded.runId);
      await admin.query(`DELETE FROM agent_runs WHERE id = $1`, [seeded.runId]);
      const row = await readBack(id);
      expect(row).toBeDefined();
      expect(row.run_id).toBeNull();
    });
  });
});
