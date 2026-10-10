import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/** D#2 H26a (migration 0670): priority columns, their two-column grant, the audit allowlist entry. */
describe('migration 0670: work item priority (D#2 H26a)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let a: SeedRefs;

  async function insertItem(priority?: number): Promise<string> {
    const id = randomUUID();
    if (priority === undefined) {
      await admin.query(
        `INSERT INTO work_items (id, account_id, repo_id, kind, provenance) VALUES ($1, $2, $3, 'bug', 'internal')`,
        [id, a.accountId, a.repoId],
      );
    } else {
      await admin.query(
        `INSERT INTO work_items (id, account_id, repo_id, kind, provenance, priority) VALUES ($1, $2, $3, 'bug', 'internal', $4)`,
        [id, a.accountId, a.repoId, priority],
      );
    }
    return id;
  }

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    a = await seedAccount(admin, randomUUID());
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await platformOpsPool.end();
  });

  describe('columns', () => {
    it('a new row defaults to priority 2 and a NULL queue_rank', async () => {
      const id = await insertItem();
      const { rows } = await admin.query(`SELECT priority, queue_rank FROM work_items WHERE id = $1`, [id]);
      expect(rows[0].priority).toBe(2);
      expect(rows[0].queue_rank).toBeNull();
    });

    it('priority accepts 0..3 and is NOT NULL', async () => {
      for (const p of [0, 1, 2, 3]) {
        const id = await insertItem(p);
        const { rows } = await admin.query(`SELECT priority FROM work_items WHERE id = $1`, [id]);
        expect(rows[0].priority).toBe(p);
      }
      await expect(admin.query(`UPDATE work_items SET priority = NULL WHERE account_id = $1`, [a.accountId])).rejects.toMatchObject({
        code: '23502',
      });
    });

    it('priority -1 and 4 are rejected by the check constraint', async () => {
      for (const p of [-1, 4]) {
        await expect(insertItem(p)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      }
    });

    it("app_user cannot write another tenant's row (RLS still applies)", async () => {
      const b = await seedAccount(admin, randomUUID());
      const id = await insertItem();
      const res = await withTenant(appUserPool, b.accountId, (c) =>
        c.query(`UPDATE work_items SET priority = 0 WHERE id = $1`, [id]),
      );
      expect(res.rowCount).toBe(0);
      const { rows } = await admin.query(`SELECT priority FROM work_items WHERE id = $1`, [id]);
      expect(rows[0].priority).toBe(2);
    });

    it('the columns app_user may UPDATE are exactly the pre-0670 set plus priority and queue_rank', async () => {
      const { rows } = await admin.query<{ column_name: string; can: boolean }>(
        `SELECT column_name, has_column_privilege('app_user', 'public.work_items', column_name, 'UPDATE') AS can
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'work_items'`,
      );
      const writable = rows.filter((r) => r.can).map((r) => r.column_name).sort();
      const closed = rows.filter((r) => !r.can).map((r) => r.column_name).sort();
      expect(closed).toEqual(PRE_0670_CLOSED);
      expect(writable).toEqual(expect.arrayContaining(['priority', 'queue_rank']));
      const others = writable.filter((c) => c !== 'priority' && c !== 'queue_rank');
      expect(others.length + closed.length + 2).toBe(rows.length);
      // No table-level UPDATE appeared (it would open every column).
      const t = await admin.query(`SELECT has_table_privilege('app_user', 'public.work_items', 'UPDATE') AS can`);
      expect(t.rows[0].can).toBe(false);
    });

    it('app_user still cannot change provenance', async () => {
      const id = await insertItem();
      await expect(
        withTenant(appUserPool, a.accountId, (c) =>
          c.query(`UPDATE work_items SET provenance = 'external' WHERE account_id = $1 AND id = $2`, [a.accountId, id]),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('platform_ops was given no write on the new columns', async () => {
      for (const col of ['priority', 'queue_rank']) {
        const { rows } = await admin.query(
          `SELECT has_column_privilege('platform_ops', 'public.work_items', $1, 'UPDATE') AS can`,
          [col],
        );
        expect(rows[0].can).toBe(false);
      }
    });
  });

  describe('audit_write_account_action allowlist', () => {
    const OLD = ['account.paused', 'account.resumed', 'account.budgets_changed', 'account.share_public_figures_changed'];

    function call(action: string | null, payload: unknown = {}) {
      return platformOpsPool.query(`SELECT audit_write_account_action($1, $2, $3, $4::jsonb) AS id`, [
        a.accountId,
        a.userId,
        action,
        JSON.stringify(payload),
      ]);
    }

    async function count(action: string): Promise<number> {
      const { rows } = await admin.query(
        `SELECT count(*)::int AS n FROM audit_log WHERE account_id = $1 AND action = $2`,
        [a.accountId, action],
      );
      return rows[0].n;
    }

    it.each(OLD)('the existing action %s still writes', async (action) => {
      const before = await count(action);
      await call(action);
      expect(await count(action)).toBe(before + 1);
    });

    it('work_item.priority_changed writes one row with the actor stamped', async () => {
      const before = await count('work_item.priority_changed');
      await call('work_item.priority_changed', { before: { priority: 2 }, after: { priority: 0 } });
      expect(await count('work_item.priority_changed')).toBe(before + 1);
      const { rows } = await admin.query(
        `SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'work_item.priority_changed' ORDER BY created_at DESC LIMIT 1`,
        [a.accountId],
      );
      expect(rows[0].actor).toBe(a.userId);
      expect(rows[0].payload).toEqual({ before: { priority: 2 }, after: { priority: 0 } });
    });

    it('an unlisted action, including near-misses, still raises 22023 and writes nothing', async () => {
      const before = await count('work_item.deleted');
      for (const action of ['work_item.priority_change', 'work_item.deleted', 'account.deleted', null, '']) {
        await expect(call(action)).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      }
      expect(await count('work_item.deleted')).toBe(before);
    });

    it('a member-role user is still refused the new action with 42501', async () => {
      const userId = randomUUID();
      await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [userId, `${userId}@example.test`]);
      await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [
        a.accountId,
        userId,
      ]);
      await expect(
        platformOpsPool.query(`SELECT audit_write_account_action($1, $2, 'work_item.priority_changed', '{}'::jsonb)`, [
          a.accountId,
          userId,
        ]),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('the definer keeps its owner, search path and EXECUTE list after the replace', async () => {
      const { rows } = await admin.query(
        `SELECT pg_get_userbyid(proowner) AS owner, proconfig, prosecdef,
                has_function_privilege('app_user', oid, 'EXECUTE') AS app_can,
                has_function_privilege('platform_ops', oid, 'EXECUTE') AS ops_can
           FROM pg_proc WHERE proname = 'audit_write_account_action'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].owner).toBe('platform_ops');
      expect(rows[0].prosecdef).toBe(false);
      expect(rows[0].proconfig).toEqual(['search_path=pg_catalog, public, pg_temp']);
      expect(rows[0].app_can).toBe(false);
      expect(rows[0].ops_can).toBe(true);
    });
  });
});

/** The columns app_user cannot UPDATE on work_items: 0613 closes provenance, parent_id never had a column grant, and 0778 opened title (the issue read fills a NULL title). */
const PRE_0670_CLOSED = ['parent_id', 'provenance'];
