import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

/** [pg] D#600 CX-12 migration 0984: context_budget_overrides and its one writer, context_budget_override_apply. Real Postgres, row security forced. */
describe('migration 0984: context_budget_overrides and context_budget_override_apply', () => {
  let adminPool: Pool;
  let appPool: Pool;
  let opsPool: Pool;
  let admin: PoolClient;
  let a: SeedRefs; // its seeded user is the owner
  let b: SeedRefs;
  let adminUser: string;
  let member: string;

  const addMember = async (accountId: string, role: string): Promise<string> => {
    const id = randomUUID();
    await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [id, `${id}@example.test`]);
    await admin.query('INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)', [accountId, id, role]);
    return id;
  };
  const role = (user: string, repo: string, name: string, bytes: number | null, accountId = a.accountId) =>
    withTenant(appPool, accountId, user, (c) => c.query(`SELECT context_budget_override_apply('role', $1::uuid, NULL, $2, $3::int)`, [repo, name, bytes]));
  const item = (user: string, workItem: string, bytes: number | null, accountId = a.accountId) =>
    withTenant(appPool, accountId, user, (c) => c.query(`SELECT context_budget_override_apply('item', NULL, $1::uuid, NULL, $2::int)`, [workItem, bytes]));
  const rows = () => admin.query('SELECT scope, role, bytes, repo_id, work_item_id FROM context_budget_overrides WHERE account_id = $1 ORDER BY scope, role', [a.accountId]).then((r) => r.rows);
  const audits = () => admin.query(`SELECT payload FROM audit_log WHERE account_id = $1 AND action = 'context_budget.changed' ORDER BY created_at, id`, [a.accountId]).then((r) => r.rows.map((x) => x.payload));

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    admin = await adminPool.connect();
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    adminUser = await addMember(a.accountId, 'admin');
    member = await addMember(a.accountId, 'member');
  });
  afterAll(async () => {
    await admin.query('DELETE FROM context_budget_overrides');
    admin.release();
    await Promise.all([adminPool.end(), appPool.end(), opsPool.end()]);
  });

  it('an owner and an admin set a role budget and an item budget; a missing row reads as unset; a reset removes the override only', async () => {
    expect(await rows()).toEqual([]);
    await role(a.userId, a.repoId, 'executor', 8192);
    await role(adminUser, a.repoId, 'fix', 5000);
    await item(a.userId, a.workItemId, 6000);
    expect(await rows()).toEqual([
      { scope: 'item', role: null, bytes: 6000, repo_id: null, work_item_id: a.workItemId },
      { scope: 'role', role: 'executor', bytes: 8192, repo_id: a.repoId, work_item_id: null },
      { scope: 'role', role: 'fix', bytes: 5000, repo_id: a.repoId, work_item_id: null },
    ]);
    await role(a.userId, a.repoId, 'executor', 9000); // replaces in place
    await item(a.userId, a.workItemId, null); // the item reset leaves the roles
    expect((await rows()).map((r) => [r.scope, r.role, r.bytes])).toEqual([['role', 'executor', 9000], ['role', 'fix', 5000]]);
    await role(a.userId, a.repoId, 'executor', null);
    await role(a.userId, a.repoId, 'fix', null);
    expect(await rows()).toEqual([]);
  });

  it('each real change writes one audit row with ids, role and old and new size; an equal value or a reset of nothing writes none', async () => {
    const before = (await audits()).length;
    await role(a.userId, a.repoId, 'debater', 10000);
    await role(a.userId, a.repoId, 'debater', 10000);
    await role(a.userId, a.repoId, 'debater', 12000);
    await item(a.userId, a.workItemId, null); // nothing stored: no change
    await item(a.userId, a.workItemId, 4096);
    await item(a.userId, a.workItemId, null);
    await role(a.userId, a.repoId, 'debater', null);
    const added = (await audits()).slice(before);
    expect(added).toEqual([
      { scope: 'role', repo_id: a.repoId, work_item_id: null, role: 'debater', from: null, to: 10000 },
      { scope: 'role', repo_id: a.repoId, work_item_id: null, role: 'debater', from: 10000, to: 12000 },
      { scope: 'item', repo_id: null, work_item_id: a.workItemId, role: null, from: null, to: 4096 },
      { scope: 'item', repo_id: null, work_item_id: a.workItemId, role: null, from: 4096, to: null },
      { scope: 'role', repo_id: a.repoId, work_item_id: null, role: 'debater', from: 12000, to: null },
    ]);
  });

  it('a member is refused (42501) on both scopes; another account answers no_data_found (P0002), not 42501; a platform_ops login is refused', async () => {
    await expect(role(member, a.repoId, 'executor', 8192)).rejects.toMatchObject({ code: '42501' });
    await expect(item(member, a.workItemId, 8192)).rejects.toMatchObject({ code: '42501' });
    await expect(role(b.userId, a.repoId, 'executor', 8192, b.accountId)).rejects.toMatchObject({ code: 'P0002' });
    await expect(item(b.userId, a.workItemId, 8192, b.accountId)).rejects.toMatchObject({ code: 'P0002' });
    await expect(role(randomUUID(), a.repoId, 'executor', 8192)).rejects.toMatchObject({ code: '42501' });
    // A platform_ops login: it holds no EXECUTE (PUBLIC is revoked), so the call is refused before the body, with either scope, whatever session it names.
    expect((await admin.query(`SELECT has_function_privilege('platform_ops', 'context_budget_override_apply(text,uuid,uuid,text,integer)', 'EXECUTE') AS p`)).rows[0].p).toBe(false);
    for (const sql of [`SELECT context_budget_override_apply('role', '${a.repoId}', NULL, 'executor', 8192)`, `SELECT context_budget_override_apply('item', NULL, '${a.workItemId}', NULL, 8192)`]) {
      await expect(withTenant(opsPool, a.accountId, a.userId, (c) => c.query(sql)), sql).rejects.toMatchObject({ code: '42501' });
    }
    expect(await rows()).toEqual([]);
  });

  it('bad shapes and values are invalid_message (22023) with nothing written: both bounds of the absolute range, an unknown role, a mixed scope', async () => {
    for (const bytes of [0, 4095, 2_097_153]) await expect(role(a.userId, a.repoId, 'executor', bytes), String(bytes)).rejects.toMatchObject({ code: '22023', message: 'invalid_message' });
    await expect(role(a.userId, a.repoId, 'planner', 8192)).rejects.toMatchObject({ code: '22023' });
    await expect(withTenant(appPool, a.accountId, a.userId, (c) => c.query(`SELECT context_budget_override_apply('item', $1::uuid, $2::uuid, NULL, 8192)`, [a.repoId, a.workItemId]))).rejects.toMatchObject({ code: '22023' });
    await expect(withTenant(appPool, a.accountId, a.userId, (c) => c.query(`SELECT context_budget_override_apply('role', $1::uuid, NULL, NULL, 8192)`, [a.repoId]))).rejects.toMatchObject({ code: '22023' });
    await role(a.userId, a.repoId, 'executor', 4096);
    await role(a.userId, a.repoId, 'executor', 2_097_152);
    await role(a.userId, a.repoId, 'executor', null);
    expect(await rows()).toEqual([]);
  });

  it('another account cannot read the rows (row security is forced); app_user can write nothing directly; the function is owned by the definer with PUBLIC revoked and a pinned search_path', async () => {
    await role(a.userId, a.repoId, 'fix', 7000);
    expect((await withTenant(appPool, b.accountId, b.userId, (c) => c.query('SELECT bytes FROM context_budget_overrides'))).rows).toEqual([]);
    expect((await withTenant(appPool, a.accountId, a.userId, (c) => c.query('SELECT bytes FROM context_budget_overrides'))).rows).toEqual([{ bytes: 7000 }]);
    for (const sql of [`INSERT INTO context_budget_overrides (account_id, scope, work_item_id, bytes, updated_by) VALUES ($1, 'item', $2, 5000, $3)`, 'UPDATE context_budget_overrides SET bytes = 5000', 'DELETE FROM context_budget_overrides']) {
      await expect(withTenant(appPool, a.accountId, a.userId, (c) => c.query(sql, sql.startsWith('INSERT') ? [a.accountId, a.workItemId, a.userId] : [])), sql).rejects.toMatchObject({ code: '42501' });
    }
    const flags = await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'context_budget_overrides'`);
    expect(flags.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    const fn = await admin.query(
      `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig, has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec, has_function_privilege('app_user', p.oid, 'EXECUTE') AS app_exec
         FROM pg_proc p WHERE p.proname = 'context_budget_override_apply'`,
    );
    expect(fn.rows).toEqual([{ owner: 'repo_context_settings_definer', prosecdef: true, proconfig: ['search_path=pg_catalog, public, pg_temp'], public_exec: false, app_exec: true }]);
    await role(a.userId, a.repoId, 'fix', null);
  });

  it('undo: an override goes with its work item and with its repository, so a repository added again starts with none', async () => {
    const w = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance) VALUES ($1, $2, $3, 'feature', 'internal')`, [w, a.accountId, a.repoId]);
    await item(a.userId, w, 5000);
    await role(a.userId, a.repoId, 'acceptance-tester', 5000);
    expect(await rows()).toHaveLength(2);
    await admin.query('DELETE FROM work_items WHERE id = $1', [w]);
    expect((await rows()).map((r) => r.scope)).toEqual(['role']);
    const repo = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, 7777, 'team')`, [repo, a.accountId, a.installationId]);
    await role(a.userId, repo, 'debater', 5000);
    await admin.query('DELETE FROM repos WHERE id = $1', [repo]);
    expect((await rows()).map((r) => [r.scope, r.role])).toEqual([['role', 'acceptance-tester']]);
    await role(a.userId, a.repoId, 'acceptance-tester', null);
  });

  it('run_context_inputs.budget_source: app_user may read and insert it, and the CHECK admits only item, role, repo or NULL', async () => {
    const col = await admin.query(`SELECT has_column_privilege('app_user', 'run_context_inputs', 'budget_source', 'INSERT') AS i, has_column_privilege('app_user', 'run_context_inputs', 'budget_source', 'SELECT') AS s`);
    expect(col.rows).toEqual([{ i: true, s: true }]);
    const def = await admin.query(`SELECT pg_get_constraintdef(c.oid) AS d FROM pg_constraint c WHERE c.conrelid = 'run_context_inputs'::regclass AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%budget_source%'`);
    expect(def.rows).toHaveLength(1);
    for (const word of ['item', 'role', 'repo']) expect(def.rows[0].d).toContain(`'${word}'`);
    expect(def.rows[0].d).not.toContain('default');
  });
});
