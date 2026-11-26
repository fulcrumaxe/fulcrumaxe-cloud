import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { PG_ERROR } from './helpers/pgErrors.js';
import { insertRunner } from './helpers/runnerFixtures.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

const row = (key: string, depends_on: string[] = []) => ({ row_key: key, title: `Row ${key}`, summary: 'Does a thing.', size: 'M', depends_on });
const ROADMAP = [row('A'), row('B', ['A']), row('C', ['A', 'B'])];
const PRD = '# Plan\n\nA small service.\n';

/** D#845 ON-10a (migration 1059): the survey's draft write, the setup it moves, the notice, and who can reach what. */
describe('survey draft definers [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let writerPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;
  let runnerA: string;
  let runnerA2: string;
  let adminA: string;
  let memberA: string;

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
  const setupFor = async (acct: SeedRefs, repoId?: string, phase = 'survey'): Promise<string> => {
    repoId ??= await repoFor(acct);
    const id = randomUUID();
    await admin.query(`INSERT INTO project_setups (id, account_id, repo_id, kind, phase, created_by) VALUES ($1, $2, $3, 'existing', $4, $5)`, [id, acct.accountId, repoId, phase, acct.userId]);
    return id;
  };
  const runFor = async (acct: SeedRefs, o: { role?: string; status?: string; runner?: string; gen?: number } = {}): Promise<string> => {
    const id = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status, runner_id, lease_generation) VALUES ($1, $2, $3, 'runner', $4, $5, $6)`, [id, acct.accountId, o.role ?? 'project-surveyor', o.status ?? 'pending', o.runner ?? null, o.gen ?? 0]);
    return id;
  };
  const asTenant = <T>(pool: Pool, acct: SeedRefs, fn: (c: PoolClient) => Promise<T>, user?: string) => (user ? withTenant(pool, acct.accountId, user, fn) : withTenant(pool, acct.accountId, fn));
  const start = (acct: SeedRefs, user: string, setup: string, run: string) => asTenant(appPool, acct, (c) => c.query('SELECT survey_start_record($1, $2)', [setup, run]), user);
  const record = (acct: SeedRefs, run: string, runner = runnerA, gen = 1, prd = PRD, roadmap: unknown = ROADMAP, pool = writerPool) =>
    asTenant(pool, acct, async (c) => (await c.query<{ id: string | null }>('SELECT survey_draft_record($1, $2, $3, $4, $5::jsonb) AS id', [run, runner, gen, prd, JSON.stringify(roadmap)])).rows[0]!.id);
  const fail = (acct: SeedRefs, run: string, code = 'survey_failed', reason = 'output_invalid', pool = writerPool) =>
    asTenant(pool, acct, async (c) => (await c.query<{ ok: boolean }>('SELECT survey_fail($1, $2, $3) AS ok', [run, code, reason])).rows[0]!.ok);
  const setup = async (id: string) => (await admin.query('SELECT * FROM project_setups WHERE id = $1', [id])).rows[0];
  const drafts = async (repoId: string) => (await admin.query('SELECT * FROM project_drafts WHERE repo_id = $1 ORDER BY version', [repoId])).rows;
  const draftsOf = async (setupId: string) => (await admin.query("SELECT * FROM project_drafts WHERE setup_id = $1", [setupId])).rows;
  const notices = async (acct: SeedRefs, setupId: string) => (await admin.query(`SELECT payload FROM domain_events WHERE account_id = $1 AND type = 'setup.changed' AND subject_id = $2`, [acct.accountId, setupId])).rows.length;
  /** A live survey: a setup in phase survey, a pending run bound to it by a person, then running as runnerA at generation 1. */
  const live = async (acct = a, repoId?: string, runner = runnerA) => {
    repoId ??= await repoFor(acct);
    const s = await setupFor(acct, repoId);
    const r = await runFor(acct);
    await start(acct, adminA, s, r);
    await admin.query(`UPDATE agent_runs SET status = 'running', runner_id = $2, lease_generation = 1 WHERE id = $1`, [r, runner]);
    return { s, r, repo: repoId };
  };

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    writerPool = createPool(process.env.DATABASE_URL_RUN_WRITER!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    adminA = await addUser(a, 'admin');
    memberA = await addUser(a, 'member');
    runnerA = await insertRunner(admin, a.accountId, a.userId);
    runnerA2 = await insertRunner(admin, a.accountId, a.userId);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, appPool, writerPool]) await p.end();
  });

  describe('survey_start_record', () => {
    it('binds a pending survey run to a setup in phase survey, starts it, clears an earlier failure and says so once', async () => {
      const s = await setupFor(a);
      const r = await runFor(a);
      await start(a, adminA, s, r);
      expect(await setup(s)).toMatchObject({ survey_run_id: r, state: 'started', phase: 'survey', failure_code: null, failure_reason: null });
      expect((await setup(s)).survey_started_at).toBeInstanceOf(Date);
      expect(await notices(a, s)).toBe(1);
    });

    it('is for an owner or admin of the account only: a member, another account, a runner session and a stranger are refused', async () => {
      const s = await setupFor(a);
      const r = await runFor(a);
      await expect(start(a, memberA, s, r)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(start(b, b.userId, s, r)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(start(a, randomUUID(), s, r)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(asTenant(appPool, a, async (c) => { await c.query(`SELECT set_config('app.runner_id', $1, true)`, [runnerA]); return c.query('SELECT survey_start_record($1, $2)', [s, r]); }, adminA)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect((await setup(s)).survey_run_id).toBeNull();
    });

    it('refuses a run that is not a pending survey run (another role, started, another account) and a setup not in phase survey', async () => {
      const s = await setupFor(a);
      for (const r of [await runFor(a, { role: 'executor' }), await runFor(a, { status: 'running', runner: runnerA, gen: 1 }), await runFor(b)]) {
        await expect(start(a, adminA, s, r)).rejects.toMatchObject({ code: '22023' });
      }
      const planned = await setupFor(a, await repoFor(a), 'plan');
      await expect(start(a, adminA, planned, await runFor(a))).rejects.toMatchObject({ code: '55000' });
      expect((await setup(s)).survey_run_id).toBeNull();
    });

    it('allows one live survey run per setup, and a new one after the failed run is over; one run serves one setup', async () => {
      const { s, r } = await live();
      await expect(start(a, adminA, s, await runFor(a))).rejects.toMatchObject({ code: '55000' });
      const bound = await runFor(a);
      await start(a, adminA, await setupFor(a), bound);
      await expect(start(a, adminA, await setupFor(a), bound)).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
      await fail(a, r, 'survey_failed', 'run_failed');
      await admin.query(`UPDATE agent_runs SET status = 'failed' WHERE id = $1`, [r]);
      const again = await runFor(a);
      await start(a, adminA, s, again);
      expect(await setup(s)).toMatchObject({ survey_run_id: again, state: 'started', failure_code: null, failure_reason: null });
    });
  });

  describe('survey_draft_record', () => {
    it('writes one draft: source survey, version 1, the setup, every row keep: true; the setup goes to plan/ok with one notice', async () => {
      const { s, r, repo } = await live();
      const id = await record(a, r);
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      const [d, ...rest] = await drafts(repo);
      expect(rest).toEqual([]);
      expect(d).toMatchObject({ id, source: 'survey', version: 1, setup_id: s, status: 'draft', prd_md: PRD, account_id: a.accountId });
      expect(d.roadmap).toEqual(ROADMAP.map((x) => ({ ...x, keep: true })));
      expect(await setup(s)).toMatchObject({ phase: 'plan', state: 'ok', failure_code: null, survey_run_id: r });
      expect(await notices(a, s)).toBe(2);
    });

    it('is idempotent: after the run ended, a repeat returns the same draft and inserts nothing', async () => {
      const { r } = await live(a, await repoFor(a));
      const id = await record(a, r);
      await admin.query(`UPDATE agent_runs SET status = 'succeeded' WHERE id = $1`, [r]);
      expect(await record(a, r)).toBe(id);
      expect((await admin.query('SELECT count(*)::int AS n FROM project_drafts WHERE id = $1', [id])).rows[0].n).toBe(1);
    });

    it('numbers per repo: a second survey on the same repo is version 2', async () => {
      const repo = await repoFor(a);
      const first = await live(a, repo);
      await record(a, first.r);
      await admin.query(`UPDATE project_setups SET phase = 'done' WHERE id = $1`, [first.s]);
      const second = await live(a, repo);
      await record(a, second.r);
      expect((await drafts(repo)).map((d) => [d.version, d.setup_id])).toEqual([[1, first.s], [2, second.s]]);
    });

    it('refuses another runner, a stale generation, a run of another role and another account, each with nothing stored', async () => {
      const { s, r } = await live();
      await expect(record(a, r, runnerA2)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(record(a, r, runnerA, 2)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(record(a, r, runnerA, 0)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(record(b, r)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      const other = await runFor(a, { role: 'executor', status: 'running', runner: runnerA, gen: 1 });
      await expect(record(a, other)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(record(a, randomUUID())).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect((await setup(s)).phase).toBe('survey');
      expect(await draftsOf(s)).toEqual([]);
    });

    it('stores nothing and answers NULL for a run no setup waits for, a setup that moved on and a setup whose survey already failed', async () => {
      const lone = await runFor(a, { status: 'running', runner: runnerA, gen: 1 });
      expect(await record(a, lone)).toBeNull();
      const { s, r } = await live();
      await admin.query(`UPDATE project_setups SET phase = 'install' WHERE id = $1`, [s]);
      expect(await record(a, r)).toBeNull();
      const failed = await live();
      expect(await fail(a, failed.r)).toBe(true);
      expect(await record(a, failed.r)).toBeNull();
      expect(await draftsOf(failed.s)).toEqual([]);
    });

    it.each([
      ['a duplicate key', [row('A'), row('A')]],
      ['an unresolved dependency', [row('A', ['Z'])]],
      ['a self dependency', [row('A', ['A'])]],
      ['a dependency that is not a key', [row('A', ['not a key'])]],
      ['a row that is not an object', [row('A'), 'B']],
      ['a title over 120 characters', [{ ...row('A'), title: 'x'.repeat(121) }]],
      ['an unknown size', [{ ...row('A'), size: 'XL' }]],
      ['more than 200 rows', Array.from({ length: 201 }, (_, i) => row(`R${i}`))],
    ])('refuses %s in the roadmap: NULL, no draft, the setup untouched', async (_label, roadmap) => {
      const { s, r } = await live();
      expect(await record(a, r, runnerA, 1, PRD, roadmap)).toBeNull();
      expect(await setup(s)).toMatchObject({ phase: 'survey', state: 'started' });
      expect(await draftsOf(s)).toEqual([]);
    });

    it('refuses a PRD over the table cap the same way, and a roadmap that is not an array', async () => {
      const { s, r } = await live();
      expect(await record(a, r, runnerA, 1, 'x'.repeat(200_001))).toBeNull();
      expect(await record(a, r, runnerA, 1, PRD, { not: 'an array' })).toBeNull();
      expect(await setup(s)).toMatchObject({ phase: 'survey', state: 'started' });
    });

    it('is executable by the run-writer login only: not by the app login, and not by any login for the internal writer', async () => {
      const { r } = await live();
      await expect(record(a, r, runnerA, 1, PRD, ROADMAP, appPool)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      for (const pool of [appPool, writerPool]) {
        await expect(asTenant(pool, a, (c) => c.query(`SELECT project_draft_insert($1, $2, NULL, 'blank', 'x', '[]'::jsonb)`, [a.accountId, a.repoId]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
        await expect(asTenant(pool, a, (c) => c.query(`SELECT project_setup_notice($1, $2)`, [randomUUID(), a.repoId]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
    });
  });

  describe('survey_fail', () => {
    it('writes the failed state with a closed code and reason, stores no draft, and says so once; true only while the setup waits for that run', async () => {
      const { s, r } = await live();
      expect(await fail(a, r, 'survey_timeout', 'deadline')).toBe(true);
      expect(await setup(s)).toMatchObject({ phase: 'survey', state: 'failed', failure_code: 'survey_timeout', failure_reason: 'deadline' });
      expect(await notices(a, s)).toBe(2);
      expect(await fail(a, r)).toBe(false);
      expect(await fail(a, randomUUID())).toBe(false);
      expect(await draftsOf(s)).toEqual([]);
    });

    it('takes only the closed lists, and is not callable by the app login or for another account', async () => {
      const { s, r } = await live();
      await expect(fail(a, r, 'survey_exploded', 'deadline')).rejects.toMatchObject({ code: '22023' });
      await expect(fail(a, r, 'survey_failed', 'my own words')).rejects.toMatchObject({ code: '22023' });
      await expect(fail(a, r, 'survey_failed', 'output_invalid', appPool)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect(await fail(b, r)).toBe(false);
      expect(await setup(s)).toMatchObject({ state: 'started' });
    });
  });

  describe('the owner role', () => {
    it('is NOLOGIN, a member of nothing, holds no sealed column and no table it does not use', async () => {
      const { rows } = await admin.query(`SELECT rolcanlogin, rolsuper, rolbypassrls, (SELECT count(*)::int FROM pg_auth_members m WHERE m.member = r.oid) AS memberships FROM pg_roles r WHERE rolname = 'project_drafts_owner'`);
      expect(rows[0]).toEqual({ rolcanlogin: false, rolsuper: false, rolbypassrls: false, memberships: 0 });
      for (const table of ['model_connections', 'runners', 'machine_jobs', 'ledger', 'audit_log']) {
        expect((await admin.query(`SELECT has_table_privilege('project_drafts_owner', $1, 'SELECT') AS s`, [table])).rows[0].s, table).toBe(false);
      }
      expect((await admin.query(`SELECT has_column_privilege('project_drafts_owner', 'agent_runs', 'envelope', 'SELECT') AS s`)).rows[0].s).toBe(false);
      // 1103 (twin_adopt_draft) lets it read the draft text to copy a public repo's plan to its twin; it still holds no UPDATE or DELETE on a draft.
      expect((await admin.query(`SELECT has_column_privilege('project_drafts_owner', 'project_drafts', 'prd_md', 'UPDATE') AS s`)).rows[0].s).toBe(false);
    });
  });
});
