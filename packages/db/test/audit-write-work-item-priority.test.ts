import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/** D#2 H26b (migration 0676): audit_write_work_item_priority(), the app_user-callable audit definer. */
describe('audit_write_work_item_priority (D#2 H26b)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;
  let aAdmin: string;
  let aMember: string;
  let itemA: string;
  let itemB: string;

  async function addMember(accountId: string, role: 'admin' | 'member'): Promise<string> {
    const userId = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [userId, `${userId}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [accountId, userId, role]);
    return userId;
  }

  async function newItem(refs: SeedRefs): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO work_items (id, account_id, repo_id, kind, provenance) VALUES ($1, $2, $3, 'bug', 'internal')`,
      [id, refs.accountId, refs.repoId],
    );
    return id;
  }

  function call(accountId: string, userId: string, workItemId: string | null, payload: unknown = { n: 1 }) {
    return withTenant(appUserPool, accountId, userId, (c) =>
      c.query<{ id: string }>(`SELECT audit_write_work_item_priority($1::uuid, $2::jsonb) AS id`, [
        workItemId,
        payload === null ? null : JSON.stringify(payload),
      ]),
    );
  }

  async function auditRows(accountId: string) {
    const { rows } = await admin.query<{ actor: string; action: string; payload: Record<string, unknown>; created_at: Date }>(
      `SELECT actor, action, payload, created_at FROM audit_log WHERE account_id = $1 AND action = 'work_item.priority_changed'`,
      [accountId],
    );
    return rows;
  }

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    aAdmin = await addMember(a.accountId, 'admin');
    aMember = await addMember(a.accountId, 'member');
    itemA = await newItem(a);
    itemB = await newItem(b);
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await platformOpsPool.end();
  });

  it('an owner and an admin session each write one row, with the action fixed', async () => {
    for (const who of [a.userId, aAdmin]) {
      const { rows } = await call(a.accountId, who, itemA);
      expect(rows[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
    }
    const rows = await auditRows(a.accountId);
    expect(rows.map((r) => r.actor).sort()).toEqual([a.userId, aAdmin].sort());
    expect(rows.every((r) => r.action === 'work_item.priority_changed')).toBe(true);
  });

  it('stamps actor, account_id and created_at over a forged payload', async () => {
    const forged = { actor: randomUUID(), account_id: b.accountId, created_at: '1999-01-01T00:00:00Z', keep: 'x' };
    await call(a.accountId, a.userId, itemA, forged);
    const row = (await auditRows(a.accountId)).find((r) => r.payload.keep === 'x')!;
    expect(row.payload.actor).toBe(a.userId);
    expect(row.payload.account_id).toBe(a.accountId);
    expect(row.payload.created_at).not.toBe(forged.created_at);
    expect(row.actor).toBe(a.userId);
    expect(await auditRows(b.accountId)).toHaveLength(0);
  });

  it('a member calling it directly (bypassing the service) is refused and writes nothing', async () => {
    const before = (await auditRows(a.accountId)).length;
    await expect(call(a.accountId, aMember, itemA)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    expect((await auditRows(a.accountId)).length).toBe(before);
  });

  it("account A's tenant with account B's work item raises and writes nothing", async () => {
    const beforeA = (await auditRows(a.accountId)).length;
    const beforeB = (await auditRows(b.accountId)).length;
    await expect(call(a.accountId, a.userId, itemB)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    expect((await auditRows(a.accountId)).length).toBe(beforeA);
    expect((await auditRows(b.accountId)).length).toBe(beforeB);
  });

  it("another tenant's publicly listed work item is still refused (0664 lets platform_ops see it)", async () => {
    await admin.query('INSERT INTO board_repo_settings (account_id, repo_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
      b.accountId,
      b.repoId,
    ]);
    await admin.query(
      `INSERT INTO board_listings (account_id, id, work_item_id, repo_id, visibility, spec_sha256, spec_snapshot, file_scope)
       VALUES ($1, $2, $3, $4, 'public', 'x', 's', ARRAY['a'])`,
      [b.accountId, randomUUID(), itemB, b.repoId],
    );
    const beforeA = (await auditRows(a.accountId)).length;
    const beforeB = (await auditRows(b.accountId)).length;
    await expect(call(a.accountId, a.userId, itemB)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    expect((await auditRows(a.accountId)).length).toBe(beforeA);
    expect((await auditRows(b.accountId)).length).toBe(beforeB);
  });

  it('a NULL or unknown work item id raises', async () => {
    await expect(call(a.accountId, a.userId, null)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    await expect(call(a.accountId, a.userId, randomUUID())).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
  });

  it('a session with no tenant, or a user who is not a member of the tenant, raises', async () => {
    await expect(
      adminPool.query(`SELECT audit_write_work_item_priority($1::uuid, '{}'::jsonb)`, [itemA]),
    ).rejects.toBeTruthy();
    await expect(call(a.accountId, randomUUID(), itemA)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
  });

  it('rejects a non-object payload, and a payload over 64 KiB', async () => {
    await expect(call(a.accountId, a.userId, itemA, [1])).rejects.toMatchObject({ code: '22023' });
    await expect(call(a.accountId, a.userId, itemA, { big: 'x'.repeat(70000) })).rejects.toMatchObject({ code: '22023' });
  });

  it('app_user can call it and PUBLIC cannot; platform_ops cannot either', async () => {
    const { rows } = await admin.query<{ app: boolean; ops: boolean; pub: boolean; definer: boolean; owner: string }>(
      `SELECT has_function_privilege('app_user', p.oid, 'EXECUTE') AS app,
              has_function_privilege('platform_ops', p.oid, 'EXECUTE') AS ops,
              COALESCE((SELECT bool_or(a.grantee = 0) FROM aclexplode(p.proacl) a), false) AS pub,
              p.prosecdef AS definer,
              pg_get_userbyid(p.proowner) AS owner
         FROM pg_proc p WHERE p.proname = 'audit_write_work_item_priority'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ app: true, pub: false, definer: true, owner: 'platform_ops' });
    // The owner holds EXECUTE implicitly; a direct platform_ops login writes nothing (no tenant).
    await expect(
      platformOpsPool.query(`SELECT audit_write_work_item_priority($1::uuid, '{}'::jsonb)`, [itemA]),
    ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
  });

  it('pins its search_path', async () => {
    const { rows } = await admin.query<{ proconfig: string[] }>(
      `SELECT proconfig FROM pg_proc WHERE proname = 'audit_write_work_item_priority'`,
    );
    expect(rows[0]!.proconfig).toContain('search_path=pg_catalog, public, pg_temp');
  });

  describe('no other grant changed', () => {
    it('the migration grants EXECUTE on this one function and nothing else', () => {
      const sql = readFileSync(new URL('../migrations/0676_audit_write_work_item_priority.sql', import.meta.url), 'utf8');
      const stmts = sql.replace(/--.*$/gm, '').match(/\b(GRANT|REVOKE)\b[^;]*;/g) ?? [];
      expect(stmts.map((s) => s.replace(/\s+/g, ' ').trim())).toEqual([
        'GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;',
        'REVOKE ALL ON FUNCTION audit_write_work_item_priority(uuid, jsonb) FROM PUBLIC;',
        'GRANT EXECUTE ON FUNCTION audit_write_work_item_priority(uuid, jsonb) TO app_user;',
        'GRANT CREATE ON SCHEMA public TO platform_ops;',
        'REVOKE CREATE ON SCHEMA public FROM platform_ops;',
        'GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;',
      ]);
    });

    it('the neighbouring definers and tables keep their grants', async () => {
      const q = async (sql: string) => (await admin.query<{ can: boolean }>(sql)).rows[0]!.can;
      // audit_write_account_action stays platform_ops-only (H26a's app_can=false assertion).
      expect(await q(`SELECT has_function_privilege('app_user', 'audit_write_account_action(uuid, uuid, text, jsonb)', 'EXECUTE') AS can`)).toBe(false);
      expect(await q(`SELECT has_function_privilege('platform_ops', 'audit_write_account_action(uuid, uuid, text, jsonb)', 'EXECUTE') AS can`)).toBe(true);
      // app_user still has no INSERT on audit_log, and platform_ops still cannot write the new columns.
      expect(await q(`SELECT has_table_privilege('app_user', 'public.audit_log', 'INSERT') AS can`)).toBe(false);
      for (const col of ['priority', 'queue_rank']) {
        expect(await q(`SELECT has_column_privilege('platform_ops', 'public.work_items', '${col}', 'UPDATE') AS can`)).toBe(false);
      }
      expect(await q(`SELECT has_table_privilege('app_user', 'public.work_items', 'UPDATE') AS can`)).toBe(false);
    });
  });
});
