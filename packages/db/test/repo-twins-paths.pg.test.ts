import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { PG_ERROR } from './helpers/pgErrors.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

const row = (key: string, depends_on: string[] = [], keep = true) => ({ row_key: key, title: `Row ${key}`, summary: 'Does a thing.', size: 'M', depends_on, keep });
const ROADMAP = [row('A'), row('B', ['A'])];

/** D#845 ON-27a3 (migration 1103): the twin's path writes, the install paths, adopting a plan draft; each audited, owner or admin, tenant-scoped. */
describe('repo twin paths and adopted draft [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;
  let adminA: string;
  let memberA: string;
  let adminB: string;

  const addUser = async (acct: SeedRefs, role: string): Promise<string> => {
    const id = randomUUID();
    await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [id, `${id}@example.test`]);
    await admin.query('INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)', [acct.accountId, id, role]);
    return id;
  };
  const repoFor = async (acct: SeedRefs): Promise<string> => {
    const id = randomUUID();
    await admin.query('INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, $4, $5)', [id, acct.accountId, acct.installationId, Math.floor(Math.random() * 1e9) + 10, 'team']);
    return id;
  };
  /** A live twin with a private repo, made through the real definer; returns ids. */
  const twinFor = async (acct: SeedRefs, user: string) => {
    const pub = await repoFor(acct);
    const priv = await repoFor(acct);
    const r = await as(acct, user, async (c) => (await c.query<{ o_result: string; o_id: string }>('SELECT o_result, o_id FROM twin_record($1, $2, $3, $4)', [pub, priv, 555, 'widgets-private'])).rows[0]!);
    expect(r.o_result).toBe('ok');
    return { id: r.o_id, pub, priv };
  };
  const as = <T>(acct: SeedRefs, user: string | null, fn: (c: PoolClient) => Promise<T>) => (user ? withTenant(appPool, acct.accountId, user, fn) : withTenant(appPool, acct.accountId, fn));
  const twin = async (id: string) => (await admin.query('SELECT * FROM repo_twins WHERE id = $1', [id])).rows[0];
  const revision = async (id: string): Promise<string> =>
    (await admin.query(`SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS r FROM repo_twins WHERE id = $1`, [id])).rows[0].r;
  const audits = async (acct: SeedRefs, like: string) => (await admin.query(`SELECT action, actor, payload FROM audit_log WHERE account_id = $1 AND action LIKE $2 ORDER BY created_at, id`, [acct.accountId, like])).rows;
  const setPaths = (acct: SeedRefs, user: string | null, id: string, expect_: string, o: { overlay?: string[]; binary?: string[]; ident?: string | null; plan?: string | null } = {}) =>
    as(acct, user, async (c) => (await c.query<{ o_result: string; o_revision: string | null }>('SELECT o_result, o_revision FROM twin_set_paths($1, $2, $3, $4, $5, $6)', [
      id, expect_, o.overlay ?? [], o.binary ?? [], o.ident ?? null, o.plan ?? null,
    ])).rows[0]!);
  const addInstall = (acct: SeedRefs, user: string | null, id: string, paths: string[]) =>
    as(acct, user, async (c) => (await c.query<{ o_result: string; o_count: number | null }>('SELECT o_result, o_count FROM twin_add_install_paths($1, $2)', [id, paths])).rows[0]!);
  const adopt = (acct: SeedRefs, user: string | null, id: string, setup: string) =>
    as(acct, user, async (c) => (await c.query<{ o_result: string; o_draft: string | null }>('SELECT o_result, o_draft FROM twin_adopt_draft($1, $2)', [id, setup])).rows[0]!);
  const setupFor = async (acct: SeedRefs, repoId: string, phase = 'survey'): Promise<string> => {
    const id = randomUUID();
    await admin.query(`INSERT INTO project_setups (id, account_id, repo_id, kind, phase, created_by) VALUES ($1, $2, $3, 'existing', $4, $5)`, [id, acct.accountId, repoId, phase, acct.userId]);
    return id;
  };
  const draftFor = async (acct: SeedRefs, repoId: string, v: number, o: { status?: string; roadmap?: unknown; prd?: string } = {}) => {
    const approved = o.status === 'approved';
    const final = approved || o.status === 'discarded';
    await admin.query(
      `INSERT INTO project_drafts (account_id, repo_id, source, prd_md, roadmap, version, status, approved_by, approved_at, final_at) VALUES ($1, $2, 'interview', $3, $4::jsonb, $5, $6, $7, CASE WHEN $7::uuid IS NOT NULL THEN now() END, CASE WHEN $8::boolean THEN now() END)`,
      [acct.accountId, repoId, o.prd ?? `# Plan v${v}\n`, JSON.stringify(o.roadmap ?? ROADMAP), v, o.status ?? 'draft', approved ? acct.userId : null, final],
    );
  };

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    adminA = await addUser(a, 'admin');
    memberA = await addUser(a, 'member');
    adminB = await addUser(b, 'admin');
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appPool.end();
  });

  describe('twin_set_paths', () => {
    it('writes all four fields against the revision, audits the change with names and counts, and returns the new revision', async () => {
      const t = await twinFor(a, a.userId);
      const r = await setPaths(a, adminA, t.id, await revision(t.id), { overlay: ['private/**', 'notes.md'], binary: ['assets/*.png'], ident: 'private/ids.txt', plan: 'private/plan.json' });
      expect(r.o_result).toBe('ok');
      expect(r.o_revision).toBe(await revision(t.id));
      expect(await twin(t.id)).toMatchObject({ overlay_globs: ['private/**', 'notes.md'], binary_globs: ['assets/*.png'], identifier_rules_path: 'private/ids.txt', plan_data_rules_path: 'private/plan.json' });
      const [e] = await audits(a, 'twin.paths_changed');
      expect(e).toMatchObject({ actor: adminA, payload: { twin_id: t.id, overlay_count: 2, binary_count: 1, identifier_rules_path: 'private/ids.txt', plan_data_rules_path: 'private/plan.json' } });
      expect(e.payload.changed).toEqual(['overlay_globs', 'binary_globs', 'identifier_rules_path', 'plan_data_rules_path']);
    });

    it('a stale revision answers conflict and changes and audits nothing; the same values again write no audit row', async () => {
      const t = await twinFor(a, a.userId);
      const first = await revision(t.id);
      expect((await setPaths(a, adminA, t.id, first, { overlay: ['x/**'] })).o_result).toBe('ok');
      expect((await setPaths(a, adminA, t.id, first, { overlay: ['y/**'] })).o_result).toBe('conflict');
      expect((await twin(t.id)).overlay_globs).toEqual(['x/**']);
      const before = (await audits(a, 'twin.paths_changed')).length;
      expect((await setPaths(a, adminA, t.id, await revision(t.id), { overlay: ['x/**'] })).o_result).toBe('ok');
      expect((await audits(a, 'twin.paths_changed')).length).toBe(before);
    });

    it('refuses a bad shape: a malformed or repeated glob, an absolute or climbing path, over 100, a rule file with a glob, null elements', async () => {
      const t = await twinFor(a, a.userId);
      const rev = await revision(t.id);
      const bad = [
        { overlay: ['/abs'] }, { overlay: ['a//b'] }, { overlay: ['../up'] }, { overlay: ['a/../b'] }, { overlay: ['has space'] }, { overlay: ['dup', 'dup'] },
        { overlay: Array.from({ length: 101 }, (_, i) => `d${i}/**`) }, { binary: Array.from({ length: 101 }, (_, i) => `b${i}/*`) }, { binary: ['/abs'] },
        { ident: 'rules/*.txt' }, { plan: '../x' }, { ident: 'a//b' },
      ];
      for (const o of bad) {
        await expect(setPaths(a, adminA, t.id, rev, o), JSON.stringify(o).slice(0, 60)).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      }
      await expect(as(a, adminA, (c) => c.query('SELECT * FROM twin_set_paths($1, $2, ARRAY[NULL]::text[], ARRAY[]::text[], NULL, NULL)', [t.id, rev]))).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      expect(await twin(t.id)).toMatchObject({ overlay_globs: [], binary_globs: [], identifier_rules_path: null });
    });

    it('is for an owner or admin with a person in the session: a member, no person, and another tenant are refused', async () => {
      const t = await twinFor(a, a.userId);
      const rev = await revision(t.id);
      await expect(setPaths(a, memberA, t.id, rev, { overlay: ['m/**'] })).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(setPaths(a, null, t.id, rev, { overlay: ['m/**'] })).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect((await setPaths(b, adminB, t.id, rev, { overlay: ['m/**'] })).o_result).toBe('not_found');
      expect((await twin(t.id)).overlay_globs).toEqual([]);
      expect(await audits(a, 'twin.paths_changed')).not.toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ twin_id: t.id }) }));
    });

    it('cannot change a removed twin; app_user cannot write the columns directly, and another tenant reads none of the twin', async () => {
      const t = await twinFor(a, a.userId);
      const rev = await revision(t.id);
      await as(a, adminA, (c) => c.query(`SELECT * FROM twin_change($1, 'remove')`, [t.id]));
      expect((await setPaths(a, adminA, t.id, await revision(t.id), { overlay: ['z/**'] })).o_result).toBe('bad_state');
      void rev;
      const live = await twinFor(a, a.userId);
      await expect(as(a, adminA, (c) => c.query(`UPDATE repo_twins SET overlay_globs = ARRAY['x'] WHERE id = $1`, [live.id]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect((await as(b, adminB, (c) => c.query('SELECT 1 FROM repo_twins WHERE id = $1', [live.id]))).rows).toHaveLength(0);
    });
  });

  describe('twin_add_install_paths', () => {
    it('adds without a person (a system session), merges and dedupes, never removes, and writes one audit row per change', async () => {
      const t = await twinFor(a, a.userId);
      expect(await addInstall(a, null, t.id, ['.autonomous-team/a.json', 'tools/x.sh'])).toEqual({ o_result: 'ok', o_count: 2 });
      expect(await addInstall(a, null, t.id, ['tools/x.sh', 'docs/y.md'])).toEqual({ o_result: 'ok', o_count: 3 });
      expect(await addInstall(a, null, t.id, ['tools/x.sh'])).toEqual({ o_result: 'ok', o_count: 3 });
      expect((await twin(t.id)).install_paths).toEqual(['.autonomous-team/a.json', 'docs/y.md', 'tools/x.sh']);
      const mine = (await audits(a, 'twin.install_paths_added')).filter((e) => e.payload.twin_id === t.id);
      expect(mine.map((e) => [e.actor, e.payload.added, e.payload.total])).toEqual([['system', 2, 2], ['system', 1, 3]]);
    });

    it('with a person in the session it must be an owner or admin; another tenant answers not_found; a removed twin bad_state', async () => {
      const t = await twinFor(a, a.userId);
      await expect(addInstall(a, memberA, t.id, ['a.txt'])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect((await addInstall(a, adminA, t.id, ['a.txt'])).o_result).toBe('ok');
      expect((await addInstall(b, null, t.id, ['b.txt'])).o_result).toBe('not_found');
      expect((await twin(t.id)).install_paths).toEqual(['a.txt']);
      await as(a, adminA, (c) => c.query(`SELECT * FROM twin_change($1, 'remove')`, [t.id]));
      expect((await addInstall(a, null, t.id, ['c.txt'])).o_result).toBe('bad_state');
    });

    it('refuses a path that is not one plain path, and a list past 5,000 writes nothing', async () => {
      const t = await twinFor(a, a.userId);
      for (const p of ['/abs', 'a//b', '../x', 'g*lob', 'br{ace', 'a b', '']) {
        await expect(addInstall(a, null, t.id, [p]), p).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      }
      await expect(as(a, null, (c) => c.query('SELECT * FROM twin_add_install_paths($1, ARRAY[NULL]::text[])', [t.id]))).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      const many = (from: number, n: number) => Array.from({ length: n }, (_, i) => `f/${from + i}.txt`);
      expect((await addInstall(a, null, t.id, many(0, 5000))).o_count).toBe(5000);
      expect(await addInstall(a, null, t.id, ['one-more.txt'])).toEqual({ o_result: 'too_many', o_count: 5000 });
      expect((await twin(t.id)).install_paths).toHaveLength(5000);
    });
  });

  describe('twin_adopt_draft', () => {
    it('copies the latest non-discarded draft of the public repo to the twin setup as its next survey draft and moves the setup to the plan step', async () => {
      const t = await twinFor(a, a.userId);
      await draftFor(a, t.pub, 1, { status: 'approved', prd: '# old\n' });
      await draftFor(a, t.pub, 2, { status: 'draft', prd: '# newest\n' });
      await draftFor(a, t.pub, 3, { status: 'discarded', prd: '# thrown away\n' });
      const s = await setupFor(a, t.priv);
      const r = await adopt(a, adminA, t.id, s);
      expect(r.o_result).toBe('ok');
      const d = (await admin.query('SELECT * FROM project_drafts WHERE id = $1', [r.o_draft])).rows[0];
      expect(d).toMatchObject({ repo_id: t.priv, setup_id: s, source: 'survey', status: 'draft', version: 1, prd_md: '# newest\n' });
      expect(d.roadmap.map((x: { row_key: string; keep: boolean }) => [x.row_key, x.keep])).toEqual([['A', true], ['B', true]]);
      expect((await admin.query('SELECT phase, state, survey_run_id FROM project_setups WHERE id = $1', [s])).rows[0]).toEqual({ phase: 'plan', state: 'ok', survey_run_id: null });
      const [e] = (await audits(a, 'twin.draft_adopted')).filter((x) => x.payload.twin_id === t.id);
      expect(e).toMatchObject({ actor: adminA, payload: { setup_id: s, draft_id: r.o_draft, public_repo_id: t.pub, private_repo_id: t.priv } });
      expect((await admin.query(`SELECT count(*)::int AS n FROM domain_events WHERE account_id = $1 AND type = 'setup.changed' AND subject_id = $2`, [a.accountId, s])).rows[0].n).toBe(1);
    });

    it('a second call, a setup past the survey step, or one with a survey started is bad_state and copies nothing more', async () => {
      const t = await twinFor(a, a.userId);
      await draftFor(a, t.pub, 1, { status: 'approved' });
      const s = await setupFor(a, t.priv);
      expect((await adopt(a, adminA, t.id, s)).o_result).toBe('ok');
      expect((await adopt(a, adminA, t.id, s)).o_result).toBe('bad_state');
      const t2 = await twinFor(a, a.userId);
      await draftFor(a, t2.pub, 1, { status: 'approved' });
      const s2 = await setupFor(a, t2.priv, 'install');
      expect((await adopt(a, adminA, t2.id, s2)).o_result).toBe('bad_state');
      const t3 = await twinFor(a, a.userId);
      await draftFor(a, t3.pub, 1, { status: 'approved' });
      const s3 = await setupFor(a, t3.priv);
      const run = randomUUID();
      await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1, $2, 'project-surveyor', 'runner', 'pending')`, [run, a.accountId]);
      await admin.query('UPDATE project_setups SET survey_run_id = $2, survey_started_at = now() WHERE id = $1', [s3, run]);
      expect((await adopt(a, adminA, t3.id, s3)).o_result).toBe('bad_state');
      for (const repo of [t.priv, t2.priv, t3.priv]) {
        expect(Number((await admin.query('SELECT count(*) AS n FROM project_drafts WHERE repo_id = $1', [repo])).rows[0].n)).toBe(repo === t.priv ? 1 : 0);
      }
    });

    it('answers no_draft when the public repo has nothing to carry (none, only discarded or empty ones, or a plan that no longer passes the shape)', async () => {
      const t = await twinFor(a, a.userId);
      const s = await setupFor(a, t.priv);
      expect((await adopt(a, adminA, t.id, s)).o_result).toBe('no_draft');
      await draftFor(a, t.pub, 1, { status: 'discarded' });
      await draftFor(a, t.pub, 2, { roadmap: [] });
      expect((await adopt(a, adminA, t.id, s)).o_result).toBe('no_draft');
      await admin.query(`UPDATE project_drafts SET roadmap = '[{"row_key":"A","title":"A","summary":"s","size":"M","depends_on":["Z"],"keep":true}]'::jsonb WHERE repo_id = $1 AND version = 2`, [t.pub]);
      expect((await adopt(a, adminA, t.id, s)).o_result).toBe('no_draft');
      expect((await admin.query('SELECT phase FROM project_setups WHERE id = $1', [s])).rows[0].phase).toBe('survey');
    });

    it('is for an owner or admin; another tenant, a setup of some other repo, and a removed twin are refused with nothing written', async () => {
      const t = await twinFor(a, a.userId);
      await draftFor(a, t.pub, 1, { status: 'approved' });
      const s = await setupFor(a, t.priv);
      await expect(adopt(a, memberA, t.id, s)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(adopt(a, null, t.id, s)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect((await adopt(b, adminB, t.id, s)).o_result).toBe('not_found');
      const other = await setupFor(a, await repoFor(a));
      expect((await adopt(a, adminA, t.id, other)).o_result).toBe('not_found');
      const onPublic = await setupFor(a, t.pub);
      expect((await adopt(a, adminA, t.id, onPublic)).o_result).toBe('not_found');
      await as(a, adminA, (c) => c.query(`SELECT * FROM twin_change($1, 'remove')`, [t.id]));
      expect((await adopt(a, adminA, t.id, s)).o_result).toBe('bad_state');
      expect(Number((await admin.query('SELECT count(*) AS n FROM project_drafts WHERE repo_id = $1', [t.priv])).rows[0].n)).toBe(0);
      expect((await audits(a, 'twin.draft_adopted')).filter((x) => x.payload.twin_id === t.id)).toHaveLength(0);
    });
  });

  describe('who can run them', () => {
    it('the three functions are executable by app_user alone: not PUBLIC, not the agent or platform roles', async () => {
      for (const fn of ['twin_set_paths(uuid, text, text[], text[], text, text)', 'twin_add_install_paths(uuid, text[])', 'twin_adopt_draft(uuid, uuid)']) {
        const { rows } = await admin.query(
          `SELECT has_function_privilege('app_user', $1, 'EXECUTE') AS app, has_function_privilege('agent_run_writer', $1, 'EXECUTE') AS writer,
                  (SELECT bool_or(a.grantee = 0) FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = $1::regprocedure) AS public_grant`,
          [fn],
        );
        expect(rows[0], fn).toEqual({ app: true, writer: false, public_grant: false });
      }
    });
  });
});
