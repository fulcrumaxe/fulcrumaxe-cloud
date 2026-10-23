import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { addExtraMember } from './helpers/members.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/** Migration 0799: the repo_pairing table (its CHECKs, tenant isolation, cascade) and the audit_write_repo_pairing definer. */
describe('repo_pairing (migration 0799)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;
  let aAdmin: string;
  let aMember: string;

  const insert = (who: SeedRefs, repoId: string, over: Record<string, unknown> = {}) => {
    const v = { code_repo: 'acme/pub', overlay_globs: ['docs/**'], identifier_rules_path: null, plan_data_rules_path: null, pr_footer: null, ...over };
    return withTenant(appUserPool, who.accountId, who.userId, (c) =>
      c.query(
        `INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs, identifier_rules_path, plan_data_rules_path, pr_footer) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [repoId, who.accountId, v.code_repo, v.overlay_globs, v.identifier_rules_path, v.plan_data_rules_path, v.pr_footer],
      ),
    );
  };
  const audit = (accountId: string, userId: string, action: string | null, payload: unknown = { n: 1 }) =>
    withTenant(appUserPool, accountId, userId, (c) => c.query(`SELECT audit_write_repo_pairing($1::text, $2::jsonb) AS id`, [action, JSON.stringify(payload)]));
  const auditRows = async (accountId: string) =>
    (await admin.query(`SELECT actor, action, payload FROM audit_log WHERE account_id = $1 AND action LIKE 'repo_pairing.%' ORDER BY created_at`, [accountId])).rows;

  async function freshRepo(who: SeedRefs): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(`INSERT INTO repos (account_id, gh_repo_id, product) VALUES ($1, $2, 'web') RETURNING id`, [
      who.accountId,
      Math.floor(Math.random() * 1e9),
    ]);
    return rows[0]!.id;
  }

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    aAdmin = await addExtraMember(admin, a.accountId, 'admin');
    aMember = await addExtraMember(admin, a.accountId, 'member');
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
  });

  it('stores a valid row, one per repo, and lets the tenant read only its own', async () => {
    const repo = await freshRepo(a);
    await insert(a, repo, { identifier_rules_path: 'rules/ids.txt', plan_data_rules_path: 'rules/plan.json' });
    await expect(insert(a, repo)).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
    const own = await withTenant(appUserPool, a.accountId, a.userId, (c) => c.query(`SELECT repo_id FROM repo_pairing WHERE repo_id = $1`, [repo]));
    expect(own.rows).toHaveLength(1);
    const other = await withTenant(appUserPool, b.accountId, b.userId, (c) => c.query(`SELECT repo_id FROM repo_pairing`));
    expect(other.rows.find((r) => r.repo_id === repo)).toBeUndefined();
  });

  it('refuses a row for another tenant\'s repo (composite FK) and a row stamped with another account (RLS)', async () => {
    const bRepo = await freshRepo(b);
    await expect(insert(a, bRepo)).rejects.toBeTruthy();
    const aRepo = await freshRepo(a);
    await expect(
      withTenant(appUserPool, a.accountId, a.userId, (c) =>
        c.query(`INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs) VALUES ($1, $2, 'x/y', '{p}')`, [aRepo, b.accountId]),
      ),
    ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
  });

  it('enforces the code repo and path rules in the database, not only in the service', async () => {
    const repo = await freshRepo(a);
    const bad: [string, Record<string, unknown>][] = [
      ['no slash', { code_repo: 'widgets' }],
      ['a URL', { code_repo: 'https://github.com/a/b' }],
      ['a dot-dot name', { code_repo: 'acme/..' }],
      ['a leading-hyphen owner', { code_repo: '-a/b' }],
      ['no globs', { overlay_globs: [] }],
      ['101 globs', { overlay_globs: Array.from({ length: 101 }, (_, i) => `p${i}`) }],
      ['a null glob', { overlay_globs: ['a', null] }],
      ['an empty glob', { overlay_globs: [''] }],
      ['an absolute glob', { overlay_globs: ['/x'] }],
      ['a climbing glob', { overlay_globs: ['a/../b'] }],
      ['a trailing dot-dot', { overlay_globs: ['a/..'] }],
      ['a backslash', { overlay_globs: ['a\\b'] }],
      ['a space', { overlay_globs: ['a b'] }],
      ['a control character', { overlay_globs: ['a\u0001b'] }],
      ['a duplicate glob', { overlay_globs: ['a', 'a'] }],
      ['a 201-character glob', { overlay_globs: ['a'.repeat(201)] }],
      ['a glob in the identifier rule path', { identifier_rules_path: 'r/*.txt' }],
      ['a brace in the plan-data rule path', { plan_data_rules_path: 'r/{a,b}.json' }],
      ['an empty rule path', { identifier_rules_path: '' }],
      ['an empty footer', { pr_footer: '' }],
      ['a 201-character footer', { pr_footer: 'x'.repeat(201) }],
      ['a newline in the footer', { pr_footer: 'a\nb' }],
    ];
    for (const [label, over] of bad) {
      await expect(insert(a, repo, over), label).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    }
    expect((await admin.query(`SELECT 1 FROM repo_pairing WHERE repo_id = $1`, [repo])).rows).toHaveLength(0);
  });

  it('stores a footer of 1 to 200 characters, or none', async () => {
    const repo = await freshRepo(a);
    await insert(a, repo, { pr_footer: 'x'.repeat(200) });
    expect((await admin.query(`SELECT pr_footer FROM repo_pairing WHERE repo_id = $1`, [repo])).rows[0].pr_footer).toHaveLength(200);
    const repo2 = await freshRepo(a);
    await insert(a, repo2);
    expect((await admin.query(`SELECT pr_footer FROM repo_pairing WHERE repo_id = $1`, [repo2])).rows[0].pr_footer).toBeNull();
  });

  it('is removed with its repo, and a repo with no row is simply off', async () => {
    const repo = await freshRepo(a);
    await insert(a, repo);
    await admin.query(`DELETE FROM repos WHERE id = $1`, [repo]);
    expect((await admin.query(`SELECT 1 FROM repo_pairing WHERE repo_id = $1`, [repo])).rows).toHaveLength(0);
  });

  it('the audit function: owner and admin write exactly the two actions, stamped from the session', async () => {
    await audit(a.accountId, a.userId, 'repo_pairing.set', { actor: randomUUID(), account_id: b.accountId, keep: 'x' });
    await audit(a.accountId, aAdmin, 'repo_pairing.cleared');
    const rows = await auditRows(a.accountId);
    expect(rows.map((r) => [r.actor, r.action])).toEqual([
      [a.userId, 'repo_pairing.set'],
      [aAdmin, 'repo_pairing.cleared'],
    ]);
    expect(rows[0].payload).toMatchObject({ actor: a.userId, account_id: a.accountId, keep: 'x' });
    expect(await auditRows(b.accountId)).toHaveLength(0);
  });

  it('the audit function refuses other actions, a member, a stranger and a bad payload, writing nothing', async () => {
    const before = (await auditRows(a.accountId)).length;
    for (const action of ['repo_pairing.deleted', 'role_settings.guard_changed', '', null]) {
      await expect(audit(a.accountId, a.userId, action)).rejects.toMatchObject({ code: '22023' });
    }
    await expect(audit(a.accountId, a.userId, 'repo_pairing.set', [1])).rejects.toMatchObject({ code: '22023' });
    await expect(audit(a.accountId, a.userId, 'repo_pairing.set', { big: 'x'.repeat(70000) })).rejects.toMatchObject({ code: '22023' });
    await expect(audit(a.accountId, aMember, 'repo_pairing.set')).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    await expect(audit(a.accountId, randomUUID(), 'repo_pairing.set')).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    expect((await auditRows(a.accountId)).length).toBe(before);
  });

  it('privileges: the audit function is a pinned definer owned by platform_ops, EXECUTE for app_user only; the validators are not public', async () => {
    const { rows } = await admin.query(
      `SELECT p.proname, has_function_privilege('app_user', p.oid, 'EXECUTE') AS app,
              COALESCE((SELECT bool_or(x.grantee = 0) FROM aclexplode(p.proacl) x), false) AS pub,
              p.prosecdef AS definer, pg_get_userbyid(p.proowner) AS owner, p.proconfig
         FROM pg_proc p WHERE p.proname IN ('audit_write_repo_pairing', 'repo_pairing_path_valid', 'repo_pairing_globs_valid') ORDER BY p.proname`,
    );
    expect(rows.map((r) => [r.proname, r.app, r.pub])).toEqual([
      ['audit_write_repo_pairing', true, false],
      ['repo_pairing_globs_valid', true, false],
      ['repo_pairing_path_valid', true, false],
    ]);
    expect(rows[0]).toMatchObject({ definer: true, owner: 'repo_pairing_audit_definer' });
    expect(rows[0].proconfig).toContain('search_path=pg_catalog, public, pg_temp');
  });
});
