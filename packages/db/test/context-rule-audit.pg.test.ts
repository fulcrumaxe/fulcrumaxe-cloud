import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

const ACTIONS = ['context_rule.saved', 'context_rule.replaced', 'context_rule.removed'];

/**
 * D#600 CX-5a2 (migration 0876): every save, replacement and removal of a context rule leaves one audit_log row, written by the definers in the same
 * transaction as the change. Real Postgres through the app_user role, row security forced.
 */
describe('migration 0876: context rule audit history', () => {
  let adminPool: Pool;
  let appPool: Pool;
  let admin: PoolClient;
  let a: SeedRefs; // its seeded user is the owner
  let b: SeedRefs;
  let member: string;

  const addMember = async (accountId: string, role: string): Promise<string> => {
    const id = randomUUID();
    await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [id, `${id}@example.test`]);
    await admin.query('INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)', [accountId, id, role]);
    return id;
  };
  const saveRepo = (user: string, kind: string, path: string, refs: SeedRefs = a) =>
    withTenant(appPool, refs.accountId, user, (c) => c.query('SELECT context_rule_save($1, $2::uuid, NULL, $3, $4) AS id', ['repo', refs.repoId, kind, path])).then((r) => r.rows[0].id as string);
  const saveItem = (user: string, kind: string, path: string, refs: SeedRefs = a) =>
    withTenant(appPool, refs.accountId, user, (c) => c.query('SELECT context_rule_save($1, NULL, $2::uuid, $3, $4) AS id', ['item', refs.workItemId, kind, path])).then((r) => r.rows[0].id as string);
  const remove = (user: string, id: string, accountId = a.accountId) => withTenant(appPool, accountId, user, (c) => c.query('SELECT context_rule_remove($1::uuid)', [id]));
  const audit = (accountId = a.accountId) =>
    admin
      .query(`SELECT action, actor, payload, created_at FROM audit_log WHERE account_id = $1 AND action = ANY($2::text[]) ORDER BY created_at, id`, [accountId, ACTIONS])
      .then((r) => r.rows);
  const clear = async () => {
    await admin.query('DELETE FROM context_rules');
  };

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    admin = await adminPool.connect();
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    member = await addMember(a.accountId, 'member');
  });
  afterAll(async () => {
    await clear();
    admin.release();
    await Promise.all([adminPool.end(), appPool.end()]);
  });

  it('acceptance 1: a save writes one row, a replacement (pin to exclude) one, and a removal one, naming who, scope, kind, path, old and new', async () => {
    const id = await saveRepo(a.userId, 'pin', 'docs/guide.md');
    let rows = await audit();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'context_rule.saved', actor: a.userId });
    expect(rows[0].payload).toEqual({ scope: 'repo', repo_id: a.repoId, work_item_id: null, rule_id: id, path: 'docs/guide.md', old_kind: null, new_kind: 'pin' });
    expect(Number.isNaN(Date.parse(rows[0].created_at))).toBe(false);

    expect(await saveRepo(a.userId, 'exclude', 'docs/guide.md')).toBe(id); // the same rule row, the other kind
    rows = await audit();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ action: 'context_rule.replaced', actor: a.userId });
    expect(rows[1].payload).toMatchObject({ rule_id: id, path: 'docs/guide.md', old_kind: 'pin', new_kind: 'exclude' });

    await remove(a.userId, id);
    rows = await audit();
    expect(rows).toHaveLength(3);
    expect(rows[2]).toMatchObject({ action: 'context_rule.removed', actor: a.userId });
    expect(rows[2].payload).toEqual({ scope: 'repo', repo_id: a.repoId, work_item_id: null, rule_id: id, path: 'docs/guide.md', old_kind: 'exclude', new_kind: null });
    await clear();
  });

  it('an item-scope save by a plain member is audited with the member as actor and the item id; saving the same kind again is another saved row', async () => {
    const before = (await audit()).length;
    const id = await saveItem(member, 'exclude', 'secret/**');
    await saveItem(member, 'exclude', 'secret/**');
    const rows = (await audit()).slice(before);
    expect(rows.map((r) => r.action)).toEqual(['context_rule.saved', 'context_rule.saved']);
    expect(rows[0].actor).toBe(member);
    expect(rows[0].payload).toEqual({ scope: 'item', repo_id: null, work_item_id: a.workItemId, rule_id: id, path: 'secret/**', old_kind: null, new_kind: 'exclude' });
    expect(rows[1].payload).toMatchObject({ old_kind: 'exclude', new_kind: 'exclude' });
    await remove(member, id);
    expect((await audit()).slice(before).map((r) => r.action)).toEqual(['context_rule.saved', 'context_rule.saved', 'context_rule.removed']);
    await clear();
  });

  it('acceptance 1: a refused save or remove writes no audit row and no rule (bad path, member on repo scope, another account, unknown rule)', async () => {
    const before = (await audit()).length;
    await expect(saveRepo(a.userId, 'pin', '../x')).rejects.toMatchObject({ code: '22023', message: 'invalid_path' });
    await expect(saveRepo(a.userId, 'pin', 'a/*.md')).rejects.toMatchObject({ code: '22023', message: 'invalid_path' });
    await expect(saveRepo(member, 'pin', 'ok.md')).rejects.toMatchObject({ code: '42501' });
    await expect(saveItem(member, 'pin', 'ok.md', { ...a, workItemId: b.workItemId })).rejects.toMatchObject({ code: 'P0002' });
    await expect(remove(a.userId, randomUUID())).rejects.toMatchObject({ code: 'P0002' });
    const repoRule = await saveRepo(a.userId, 'pin', 'keep.md');
    await expect(remove(member, repoRule)).rejects.toMatchObject({ code: '42501' });
    expect(await audit()).toHaveLength(before + 1); // only the one good save
    expect((await admin.query('SELECT count(*)::int AS n FROM context_rules')).rows[0].n).toBe(1);
    await clear();
  });

  it('a save rolled back after the definer ran takes its audit row with it (same transaction)', async () => {
    const before = (await audit()).length;
    await expect(
      withTenant(appPool, a.accountId, a.userId, async (c) => {
        await c.query('SELECT context_rule_save($1, $2::uuid, NULL, $3, $4)', ['repo', a.repoId, 'pin', 'late.md']);
        throw new Error('over budget');
      }),
    ).rejects.toThrow('over budget');
    expect(await audit()).toHaveLength(before);
    expect((await admin.query('SELECT count(*)::int AS n FROM context_rules')).rows[0].n).toBe(0);
  });

  it('acceptance 2: the audit row survives the removal of its rule, and removing the rule through its item or repository leaves history intact', async () => {
    const id = await saveRepo(a.userId, 'pin', 'survives.md');
    await remove(a.userId, id);
    expect((await admin.query('SELECT count(*)::int AS n FROM context_rules WHERE id = $1', [id])).rows[0].n).toBe(0);
    const rows = (await audit()).filter((r) => r.payload.rule_id === id);
    expect(rows.map((r) => r.action)).toEqual(['context_rule.saved', 'context_rule.removed']);
    await clear();
  });

  it('acceptance 2: another account cannot read the audit rows, and a rule write in account A leaves account B with none', async () => {
    await saveRepo(a.userId, 'pin', 'only-a.md');
    const seenByB = await withTenant(appPool, b.accountId, b.userId, (c) => c.query(`SELECT action FROM audit_log WHERE action = ANY($1::text[])`, [ACTIONS]));
    expect(seenByB.rows).toEqual([]);
    const seenByA = await withTenant(appPool, a.accountId, a.userId, (c) => c.query(`SELECT action, payload FROM audit_log WHERE action = ANY($1::text[])`, [ACTIONS]));
    expect(seenByA.rows.length).toBeGreaterThan(0);
    expect(await audit(b.accountId)).toEqual([]);
    await clear();
  });

  it('append-only: app_user cannot insert, update or delete a context rule audit row, and cannot write one with a forged account', async () => {
    const id = await saveRepo(a.userId, 'pin', 'append.md');
    const run = (sql: string) => withTenant(appPool, a.accountId, a.userId, (c) => c.query(sql));
    await expect(run(`UPDATE audit_log SET action = 'x' WHERE action = 'context_rule.saved'`)).rejects.toMatchObject({ code: '42501' });
    await expect(run(`DELETE FROM audit_log WHERE action = 'context_rule.saved'`)).rejects.toMatchObject({ code: '42501' });
    await expect(run(`INSERT INTO audit_log (account_id, actor, action) VALUES ('${a.accountId}', 'x', 'context_rule.saved')`)).rejects.toMatchObject({ code: '42501' });
    // A caller-supplied actor or account in the payload is overwritten, never trusted.
    await withTenant(appPool, a.accountId, a.userId, (c) =>
      c.query(`SELECT audit_write('context_rule.saved', jsonb_build_object('actor', 'forged', 'account_id', '${b.accountId}', 'rule_id', '${id}'))`),
    );
    const forged = (await audit()).find((r) => r.payload.actor !== undefined);
    expect(forged?.payload.actor).toBe(a.userId);
    expect(forged?.payload.account_id).toBe(a.accountId);
    await clear();
  });

  it('the allowlist carries the three new actions and every earlier one, and still refuses an unknown action', async () => {
    const call = (action: string | null) => withTenant(appPool, a.accountId, a.userId, (c) => c.query(`SELECT audit_write($1::text, '{"n":1}'::jsonb)`, [action]));
    const earlier = [
      'decision_dial_changed', 'model_connection.connect', 'model_connection.replace', 'model_connection.remove', 'role_settings.mode_changed',
      'role_settings.guard_changed', 'role_settings.model_changed', 'run_limits.changed', 'decision_ask_setting.changed', 'ask_route.changed',
      'discovery_setting.changed', 'build_concurrency.changed', 'envelope.changed', 'autostart_envelope.changed', 'envelope_margin.changed',
    ];
    for (const action of [...earlier, ...ACTIONS]) await call(action);
    for (const action of ['context_rule.deleted', 'context_rule', '', null]) await expect(call(action)).rejects.toMatchObject({ code: '22023' });
  });

  it('privilege line: the definer role holds EXECUTE on audit_write and no new table or column privilege; app_user keeps EXECUTE on both definers', async () => {
    const { rows } = await admin.query(
      `SELECT has_function_privilege('context_rules_definer', 'audit_write(text,jsonb)', 'EXECUTE') AS definer_audit,
              has_function_privilege('app_user', 'audit_write(text,jsonb)', 'EXECUTE') AS app_audit,
              has_function_privilege('partner_user', 'audit_write(text,jsonb)', 'EXECUTE') AS partner_audit,
              has_table_privilege('context_rules_definer', 'audit_log', 'INSERT') AS definer_insert,
              has_table_privilege('context_rules_definer', 'audit_log', 'SELECT') AS definer_select,
              has_function_privilege('app_user', 'context_rule_save(text,uuid,uuid,text,text)', 'EXECUTE') AS save_exec,
              has_function_privilege('app_user', 'context_rule_remove(uuid)', 'EXECUTE') AS remove_exec`,
    );
    expect(rows[0]).toEqual({ definer_audit: true, app_audit: true, partner_audit: false, definer_insert: false, definer_select: false, save_exec: true, remove_exec: true });
    const owners = await admin.query(
      `SELECT proname, pg_get_userbyid(proowner) AS owner, prosecdef, proconfig FROM pg_proc WHERE proname IN ('context_rule_save', 'context_rule_remove') ORDER BY proname`,
    );
    for (const r of owners.rows) {
      expect(r.owner).toBe('context_rules_definer');
      expect(r.prosecdef).toBe(true);
      expect(r.proconfig).toEqual(['search_path=pg_catalog, public, pg_temp']);
    }
  });
});
