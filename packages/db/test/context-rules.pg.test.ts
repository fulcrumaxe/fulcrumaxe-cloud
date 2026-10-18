import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

const ROLE = 'context_rules_definer';
const SAVE = 'context_rule_save(text,uuid,uuid,text,text)';
const REMOVE = 'context_rule_remove(uuid)';

/** D#600 CX-5a: the pins and excludes store (migration 0871), its two writers and the privilege line around them. Real Postgres, row security forced. */
describe('migration 0871: context_rules, context_rule_save and context_rule_remove', () => {
  let adminPool: Pool;
  let appPool: Pool;
  let admin: PoolClient;
  let a: SeedRefs; // its seeded user is the owner
  let b: SeedRefs;
  let adminUser: string;
  let member: string;
  let bMember: string;

  const addMember = async (accountId: string, role: string): Promise<string> => {
    const id = randomUUID();
    await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [id, `${id}@example.test`]);
    await admin.query('INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)', [accountId, id, role]);
    return id;
  };
  const saveRepo = (user: string, repo: string, kind: string, path: string, accountId = a.accountId) =>
    withTenant(appPool, accountId, user, (c) => c.query('SELECT context_rule_save($1, $2::uuid, NULL, $3, $4) AS id', ['repo', repo, kind, path])).then((r) => r.rows[0].id as string);
  const saveItem = (user: string, item: string, kind: string, path: string, accountId = a.accountId) =>
    withTenant(appPool, accountId, user, (c) => c.query('SELECT context_rule_save($1, NULL, $2::uuid, $3, $4) AS id', ['item', item, kind, path])).then((r) => r.rows[0].id as string);
  const remove = (user: string, id: string, accountId = a.accountId) => withTenant(appPool, accountId, user, (c) => c.query('SELECT context_rule_remove($1::uuid)', [id]));
  const rows = (where = 'true') => admin.query(`SELECT scope, kind, path, repo_id, work_item_id FROM context_rules WHERE ${where} ORDER BY path COLLATE "C"`).then((r) => r.rows);
  const clear = () => admin.query('DELETE FROM context_rules');

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    admin = await adminPool.connect();
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    adminUser = await addMember(a.accountId, 'admin');
    member = await addMember(a.accountId, 'member');
    bMember = await addMember(b.accountId, 'member');
  });
  afterAll(async () => {
    await clear();
    admin.release();
    await Promise.all([adminPool.end(), appPool.end()]);
  });

  it('acceptance 1: a path with .. or an absolute path is refused with invalid_path and no row is written', async () => {
    const bad = ['../x', 'a/../b', '..', '/etc/passwd', '/', 'a//b', 'a/', './a', 'a/./b', '~/x', '~', 'C:/x', 'a\\b', 'a\nb', 'a\u0001b', 'a\u007fb', 'a\u0085b', 'a\u2028b', '', 'x'.repeat(513)];
    for (const kind of ['pin', 'exclude']) {
      for (const path of bad) {
        await expect(saveRepo(a.userId, a.repoId, kind, path), `${kind} ${JSON.stringify(path)}`).rejects.toMatchObject({ code: '22023', message: 'invalid_path' });
        await expect(saveItem(member, a.workItemId, kind, path), `item ${kind} ${JSON.stringify(path)}`).rejects.toMatchObject({ code: '22023', message: 'invalid_path' });
      }
    }
    await expect(saveRepo(a.userId, a.repoId, 'pin', null as unknown as string)).rejects.toMatchObject({ message: 'invalid_path' });
    expect(await rows()).toEqual([]);
    // Names that only look like the refused ones are fine.
    for (const ok of ['a..b', '.env', 'dir/.hidden', 'a b/c.txt', '你好/x.md', 'x'.repeat(512)]) await saveRepo(a.userId, a.repoId, 'exclude', ok);
    expect((await rows()).length).toBe(6);
    await clear();
  });

  it('acceptance 5: a * or ? in a pin is refused with invalid_path; brackets and braces in a pin are literal and accepted; a glob in an exclude is accepted', async () => {
    for (const path of ['src/*.ts', 'a?b', '**/x']) {
      await expect(saveRepo(a.userId, a.repoId, 'pin', path), path).rejects.toMatchObject({ code: '22023', message: 'invalid_path' });
      await expect(saveItem(member, a.workItemId, 'pin', path), path).rejects.toMatchObject({ message: 'invalid_path' });
      await saveRepo(a.userId, a.repoId, 'exclude', path);
    }
    await saveRepo(a.userId, a.repoId, 'exclude', 'src/**/[ab].ts');
    expect((await rows()).map((r) => r.path)).toEqual(['**/x', 'a?b', 'src/**/[ab].ts', 'src/*.ts']);
    await clear();
    for (const path of ['app/[id]/page.tsx', 'app/{a,b}', 'src/index.ts']) {
      await saveRepo(a.userId, a.repoId, 'pin', path);
      await saveItem(member, a.workItemId, 'pin', path);
    }
    expect((await rows("kind = 'pin'")).length).toBe(6);
    await clear();
  });

  it('acceptance 2: a member cannot write a repo-scope rule (42501); an account member can write an item-scope rule; owner and admin write repo scope', async () => {
    await expect(saveRepo(member, a.repoId, 'pin', 'a.txt')).rejects.toMatchObject({ code: '42501' });
    await expect(saveRepo(randomUUID(), a.repoId, 'pin', 'a.txt')).rejects.toMatchObject({ code: '42501' });
    await expect(saveRepo(bMember, a.repoId, 'pin', 'a.txt', a.accountId)).rejects.toMatchObject({ code: '42501' });
    expect(await rows()).toEqual([]);
    await saveItem(member, a.workItemId, 'exclude', 'secret/a.txt');
    await saveItem(a.userId, a.workItemId, 'pin', 'README.md');
    await saveRepo(adminUser, a.repoId, 'exclude', 'vendor');
    await saveRepo(a.userId, a.repoId, 'pin', 'package.json');
    expect(await rows()).toEqual([
      { scope: 'item', kind: 'pin', path: 'README.md', repo_id: null, work_item_id: a.workItemId },
      { scope: 'repo', kind: 'pin', path: 'package.json', repo_id: a.repoId, work_item_id: null },
      { scope: 'item', kind: 'exclude', path: 'secret/a.txt', repo_id: null, work_item_id: a.workItemId },
      { scope: 'repo', kind: 'exclude', path: 'vendor', repo_id: a.repoId, work_item_id: null },
    ]);
    await clear();
  });

  it('acceptance 3: an account-B write to an account-A repo or item returns no_data_found (P0002), and nothing is written', async () => {
    await expect(saveRepo(b.userId, a.repoId, 'exclude', 'x', b.accountId)).rejects.toMatchObject({ code: 'P0002' });
    await expect(saveItem(b.userId, a.workItemId, 'exclude', 'x', b.accountId)).rejects.toMatchObject({ code: 'P0002' });
    await expect(saveItem(bMember, a.workItemId, 'exclude', 'x', b.accountId)).rejects.toMatchObject({ code: 'P0002' });
    await expect(saveItem(a.userId, randomUUID(), 'exclude', 'x')).rejects.toMatchObject({ code: 'P0002' });
    expect(await rows()).toEqual([]);
  });

  it('acceptance 3: RLS on the read path: an account reads only its own rules, and app_user cannot write the table', async () => {
    const ra = await saveRepo(a.userId, a.repoId, 'exclude', 'a-only');
    await saveRepo(b.userId, b.repoId, 'exclude', 'b-only', b.accountId);
    const own = await withTenant(appPool, a.accountId, (c) => c.query('SELECT path FROM context_rules'));
    expect(own.rows).toEqual([{ path: 'a-only' }]);
    const other = await withTenant(appPool, b.accountId, (c) => c.query('SELECT path FROM context_rules WHERE id = $1 OR repo_id = $2', [ra, a.repoId]));
    expect(other.rowCount).toBe(0);
    await expect(withTenant(appPool, a.accountId, (c) => c.query(`UPDATE context_rules SET path = 'x'`))).rejects.toMatchObject({ code: '42501' });
    await expect(withTenant(appPool, a.accountId, (c) => c.query('DELETE FROM context_rules'))).rejects.toMatchObject({ code: '42501' });
    await expect(
      withTenant(appPool, a.accountId, (c) => c.query(`INSERT INTO context_rules (account_id, scope, repo_id, kind, path, created_by) VALUES ($1, 'repo', $2, 'exclude', 'z', $3)`, [a.accountId, a.repoId, a.userId])),
    ).rejects.toMatchObject({ code: '42501' });
    const { rows: flags } = await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'context_rules'::regclass`);
    expect(flags[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    await clear();
  });

  it('saving again is one row per path and scope: the same kind keeps its id, the other kind replaces the rule', async () => {
    const first = await saveRepo(a.userId, a.repoId, 'pin', 'dup.txt');
    expect(await saveRepo(adminUser, a.repoId, 'pin', 'dup.txt')).toBe(first);
    expect(await saveRepo(a.userId, a.repoId, 'exclude', 'dup.txt')).toBe(first);
    expect(await rows()).toEqual([{ scope: 'repo', kind: 'exclude', path: 'dup.txt', repo_id: a.repoId, work_item_id: null }]);
    await saveItem(member, a.workItemId, 'pin', 'dup.txt'); // the item scope is its own
    expect((await rows()).length).toBe(2);
    await clear();
  });

  it('undo: removing a rule deletes it; a member may remove an item rule but not a repo rule; an unknown or other-account id is no_data_found', async () => {
    const repoRule = await saveRepo(a.userId, a.repoId, 'exclude', 'r.txt');
    const itemRule = await saveItem(member, a.workItemId, 'exclude', 'i.txt');
    await expect(remove(member, repoRule)).rejects.toMatchObject({ code: '42501' });
    await expect(remove(randomUUID(), repoRule)).rejects.toMatchObject({ code: '42501' });
    await expect(remove(b.userId, repoRule, b.accountId)).rejects.toMatchObject({ code: 'P0002' });
    await expect(remove(a.userId, randomUUID())).rejects.toMatchObject({ code: 'P0002' });
    await remove(member, itemRule);
    expect((await rows()).map((r) => r.path)).toEqual(['r.txt']);
    await remove(adminUser, repoRule);
    expect(await rows()).toEqual([]);
    await expect(remove(a.userId, repoRule)).rejects.toMatchObject({ code: 'P0002' }); // removing twice is a plain not-found
  });

  it('rules go with the item and with the repository; a repository removed and added again starts with none', async () => {
    const item = randomUUID();
    const repo = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product) VALUES ($1, $2, $3, 'team')`, [repo, a.accountId, Math.floor(Math.random() * 1e9)]);
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, state, provenance) VALUES ($1, $2, $3, 'feature', 'running', 'internal')`, [item, a.accountId, repo]);
    await saveItem(member, item, 'exclude', 'gone-with-item');
    await saveRepo(a.userId, repo, 'exclude', 'gone-with-repo');
    await admin.query('DELETE FROM work_items WHERE id = $1', [item]);
    expect((await rows(`repo_id = '${repo}' OR work_item_id = '${item}'`)).map((r) => r.path)).toEqual(['gone-with-repo']);
    await admin.query('DELETE FROM repos WHERE id = $1', [repo]);
    expect(await rows(`repo_id = '${repo}'`)).toEqual([]);
    const again = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product) VALUES ($1, $2, $3, 'team')`, [again, a.accountId, Math.floor(Math.random() * 1e9)]);
    expect(await rows(`repo_id = '${again}'`)).toEqual([]);
  });

  it('the table refuses a row that fits neither scope, even to its owner', async () => {
    const ins = (scope: string, repo: string | null, item: string | null) =>
      admin.query(`INSERT INTO context_rules (account_id, scope, repo_id, work_item_id, kind, path, created_by) VALUES ($1, $2, $3, $4, 'exclude', 'p', $5)`, [a.accountId, scope, repo, item, a.userId]);
    await expect(ins('repo', null, a.workItemId)).rejects.toMatchObject({ code: '23514' });
    await expect(ins('item', a.repoId, null)).rejects.toMatchObject({ code: '23514' });
    await expect(ins('repo', a.repoId, a.workItemId)).rejects.toMatchObject({ code: '23514' });
    await expect(ins('team', a.repoId, null)).rejects.toMatchObject({ code: '23514' });
  });

  it('bad scope, kind or target is invalid_message', async () => {
    const call = (args: unknown[]) => withTenant(appPool, a.accountId, a.userId, (c) => c.query('SELECT context_rule_save($1, $2::uuid, $3::uuid, $4, $5)', args));
    await expect(call(['team', a.repoId, null, 'pin', 'a'])).rejects.toMatchObject({ code: '22023', message: 'invalid_message' });
    await expect(call(['repo', a.repoId, null, 'allow', 'a'])).rejects.toMatchObject({ message: 'invalid_message' });
    await expect(call(['repo', null, null, 'pin', 'a'])).rejects.toMatchObject({ message: 'invalid_message' });
    await expect(call(['repo', a.repoId, a.workItemId, 'pin', 'a'])).rejects.toMatchObject({ message: 'invalid_message' });
    await expect(call(['item', null, null, 'pin', 'a'])).rejects.toMatchObject({ message: 'invalid_message' });
    expect(await rows()).toEqual([]);
  });

  it('the privilege line: the definer is NOLOGIN and owns exactly the two functions; EXECUTE is app_user alone; platform_ops holds nothing', async () => {
    const role = await admin.query('SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1', [ROLE]);
    expect(role.rows[0]).toEqual({ rolcanlogin: false, rolsuper: false, rolbypassrls: false });
    for (const fn of [SAVE, REMOVE]) {
      const r = await admin.query(
        `SELECT p.prosecdef, p.proconfig, (SELECT array_agg(DISTINCT pg_get_userbyid(x.grantee)::text) FROM aclexplode(p.proacl) x WHERE x.grantee <> p.proowner AND x.grantee <> 0) AS grantees,
                pg_get_userbyid(p.proowner) AS owner
           FROM pg_proc p WHERE p.oid = $1::regprocedure`,
        [fn],
      );
      expect(r.rows[0], fn).toEqual({ prosecdef: true, proconfig: ['search_path=pg_catalog, public, pg_temp'], grantees: ['app_user'], owner: ROLE });
    }
    const owned = await admin.query(`SELECT count(*)::int AS n FROM pg_proc WHERE pg_get_userbyid(proowner) = $1`, [ROLE]);
    expect(owned.rows[0].n).toBe(2);
    const ops = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    try {
      await expect(ops.query('SELECT 1 FROM context_rules')).rejects.toMatchObject({ code: '42501' });
      await expect(ops.query(`SELECT context_rule_save('repo', gen_random_uuid(), NULL, 'pin', 'a')`)).rejects.toMatchObject({ code: '42501' });
      await expect(ops.query('SELECT context_rule_remove(gen_random_uuid())')).rejects.toMatchObject({ code: '42501' });
    } finally {
      await ops.end();
    }
  });
});
