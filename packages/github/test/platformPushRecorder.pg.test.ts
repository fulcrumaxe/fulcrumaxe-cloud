import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '@fx/db/src/pool.js';
import { createPlatformPushRecorder } from '../src/platformPushRecorder.js';
import { ensureGhProxyTestLogin } from './helpers/ghProxyLogin.js';
import { seedAccountWithRepo, seedWorkItem, type SeedRefs } from './helpers/seed.js';

/**
 * D#519 MQ4-b0 (C10-7): migration 0956's push record, through the REAL function on the proxy's own narrow login. The run's facts come from its row; a
 * caller has no argument to name an account, repository, item, runtime or start commit with. app_user reads its own tenant's rows and writes none.
 */

const sha = (c: string) => c.repeat(40);
const ZERO = '0'.repeat(40);
const CALL = 'SELECT public.record_platform_ref_push($1, $2, $3, $4, $5) AS recorded';

/** A real receive-pack request body: pkt-lines for each update (capabilities after a NUL on the first), a flush, then the pack bytes. */
function receivePack(updates: Array<[string, string, string]>): Uint8Array {
  const pkt = (line: string) => (line.length + 4).toString(16).padStart(4, '0') + line;
  const lines = updates.map(([o, n, ref], i) => pkt(`${o} ${n} ${ref}${i === 0 ? '\0report-status side-band-64k agent=git/2.45.0' : ''}\n`));
  return Buffer.concat([Buffer.from(lines.join('') + '0000'), Buffer.from('PACK\0\0\0\x02\0\0\0\0')]);
}

describe('platform push records (0956)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let proxyPool: Pool;
  let appPool: Pool;
  let opsPool: Pool;
  let refs: SeedRefs;
  let other: SeedRefs;
  let itemId: string;

  beforeAll(async () => {
    adminPool = createPool(process.env.GITHUB_DATABASE_URL!);
    admin = await adminPool.connect();
    proxyPool = createPool(await ensureGhProxyTestLogin(process.env.GITHUB_DATABASE_URL!));
    appPool = createPool(process.env.GITHUB_DATABASE_URL_APP_USER!);
    opsPool = createPool(process.env.GITHUB_DATABASE_URL_PLATFORM_OPS!);
    refs = await seedAccountWithRepo(admin, 95601);
    other = await seedAccountWithRepo(admin, 95602);
    itemId = await seedWorkItem(admin, refs.accountId, refs.repoId, { ghNumber: 956 });
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([proxyPool.end(), appPool.end(), opsPool.end()]);
    await adminPool.end();
  });

  async function run(o: { role?: string; status?: string; runtime?: string; mode?: string | null; head?: string | null; sandbox?: string | null; repo?: string | null; account?: string } = {}) {
    const id = randomUUID();
    const sandbox = o.sandbox === undefined ? `sbx-push-${id}` : o.sandbox;
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode, sandbox_name, dispatch_repo_id, head_sha)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, o.account ?? refs.accountId, o.account ? null : itemId, o.role ?? 'executor', o.runtime ?? 'production', o.status ?? 'running', o.mode === undefined ? 'sandbox' : o.mode, sandbox, o.repo === undefined ? (o.account ? other.repoId : refs.repoId) : o.repo, o.head ?? null],
    );
    return { id, sandbox: sandbox! };
  }
  const rowsOf = async (runId: string) =>
    (await admin.query(`SELECT account_id, repo_id, work_item_id, run_id, runtime, ref, old_sha, new_sha, start_sha FROM platform_ref_pushes WHERE run_id = $1 ORDER BY created_at, new_sha`, [runId])).rows;
  const call = (args: unknown[]) => proxyPool.query(CALL, args);
  const code = async (p: Promise<unknown>) => p.then(() => null, (e: { code?: string }) => e.code ?? 'unknown');

  it('a sandbox push: one row whose account, repository, item, runtime and start commit are the run row\'s', async () => {
    const r = await run({ head: sha('5') });
    expect((await call([r.sandbox, null, 'refs/heads/fx/issue-956', sha('1'), sha('2')])).rows[0].recorded).toBe(true);
    expect(await rowsOf(r.id)).toEqual([
      { account_id: refs.accountId, repo_id: refs.repoId, work_item_id: itemId, run_id: r.id, runtime: 'production', ref: 'refs/heads/fx/issue-956', old_sha: sha('1'), new_sha: sha('2'), start_sha: sha('5') },
    ]);
  });

  it('a push that created the branch stores a null old id; a run from the default branch a null start', async () => {
    const r = await run();
    await call([r.sandbox, null, 'refs/heads/fx/issue-956', ZERO, sha('3')]);
    expect(await rowsOf(r.id)).toMatchObject([{ old_sha: null, new_sha: sha('3'), start_sha: null }]);
  });

  it('a runner_verified run, by the ticket\'s run id: recorded; a runner_local or a not-running runner run: nothing', async () => {
    const live = await run({ runtime: 'runner', mode: 'runner_verified', sandbox: null, head: sha('6') });
    expect((await call([null, live.id, 'refs/heads/fx/issue-956', sha('1'), sha('4')])).rows[0].recorded).toBe(true);
    expect(await rowsOf(live.id)).toMatchObject([{ runtime: 'runner', start_sha: sha('6') }]);
    const local = await run({ runtime: 'runner', mode: 'runner_local', sandbox: null });
    const ended = await run({ runtime: 'runner', mode: 'runner_verified', sandbox: null, status: 'succeeded' });
    for (const r of [local, ended]) {
      expect((await call([null, r.id, 'refs/heads/fx/issue-956', sha('1'), sha('4')])).rows[0].recorded).toBe(false);
      expect(await rowsOf(r.id)).toEqual([]);
    }
    // A runner run named by a sandbox key, or a sandbox run named by its id, is not found.
    const sbx = await run();
    expect((await call([null, sbx.id, 'refs/heads/fx/a', sha('1'), sha('4')])).rows[0].recorded).toBe(false);
    expect(await rowsOf(sbx.id)).toEqual([]);
  });

  it.each([
    ['plane_publish (a publish push goes to the paired public repository)', { role: 'plane_publish' }],
    ['a role that may not push', { role: 'code-reviewer' }],
    ['an ended run', { status: 'succeeded' }],
    ['a run with no repository', { repo: null }],
  ])('%s: nothing recorded', async (_label, o) => {
    const r = await run(o as Parameters<typeof run>[0]);
    expect((await call([r.sandbox, null, 'refs/heads/fx/x', sha('1'), sha('2')])).rows[0].recorded).toBe(false);
    expect(await rowsOf(r.id)).toEqual([]);
  });

  it('two live runs on one sandbox name: nothing; a delete (zero new id): nothing', async () => {
    const a = await run();
    const b = await run({ sandbox: a.sandbox, status: 'paused' });
    expect((await call([a.sandbox, null, 'refs/heads/fx/x', sha('1'), sha('2')])).rows[0].recorded).toBe(false);
    expect([...(await rowsOf(a.id)), ...(await rowsOf(b.id))]).toEqual([]);
    const c = await run();
    expect((await call([c.sandbox, null, 'refs/heads/fx/x', sha('1'), ZERO])).rows[0].recorded).toBe(false);
    expect(await rowsOf(c.id)).toEqual([]);
  });

  it.each([
    ['both keys', [`sbx-${randomUUID()}`, randomUUID(), 'refs/heads/fx/x', sha('1'), sha('2')]],
    ['neither key', [null, null, 'refs/heads/fx/x', sha('1'), sha('2')]],
    ['an empty sandbox name', ['', null, 'refs/heads/fx/x', sha('1'), sha('2')]],
    ['a tag', [`sbx-${randomUUID()}`, null, 'refs/tags/v1', sha('1'), sha('2')]],
    ['a ref with a control character', [`sbx-${randomUUID()}`, null, 'refs/heads/fx/\nx', sha('1'), sha('2')]],
    ['a short new id', [`sbx-${randomUUID()}`, null, 'refs/heads/fx/x', sha('1'), 'abc']],
    ['an upper-case old id', [`sbx-${randomUUID()}`, null, 'refs/heads/fx/x', 'A'.repeat(40), sha('2')]],
    ['no new id', [`sbx-${randomUUID()}`, null, 'refs/heads/fx/x', sha('1'), null]],
  ])('%s: refused with 22023', async (_label, args) => {
    expect(await code(call(args))).toBe('22023');
  });

  it('created_at is the database clock, whoever writes the row', async () => {
    const r = await run();
    await admin.query(
      `INSERT INTO platform_ref_pushes (account_id, repo_id, run_id, runtime, ref, new_sha, created_at) VALUES ($1, $2, $3, 'production', 'refs/heads/fx/x', $4, '2001-01-01')`,
      [refs.accountId, refs.repoId, r.id, sha('7')],
    );
    const { rows } = await admin.query(`SELECT created_at > now() - interval '1 minute' AS fresh FROM platform_ref_pushes WHERE run_id = $1`, [r.id]);
    expect(rows).toEqual([{ fresh: true }]);
  });

  describe('app_user', () => {
    async function asTenant<T>(accountId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
      const c = await appPool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.account_id', $1, true)`, [accountId]);
        return await fn(c);
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        c.release();
      }
    }

    it('reads its own tenant\'s rows and no other tenant\'s', async () => {
      const mine = await run();
      await call([mine.sandbox, null, 'refs/heads/fx/mine', sha('1'), sha('8')]);
      const theirs = await run({ account: other.accountId });
      await call([theirs.sandbox, null, 'refs/heads/fx/theirs', sha('1'), sha('9')]);
      const seen = await asTenant(refs.accountId, async (c) => (await c.query(`SELECT run_id FROM platform_ref_pushes WHERE run_id = ANY($1::uuid[])`, [[mine.id, theirs.id]])).rows);
      expect(seen).toEqual([{ run_id: mine.id }]);
      expect(await asTenant(other.accountId, async (c) => (await c.query(`SELECT 1 FROM platform_ref_pushes WHERE run_id = $1`, [mine.id])).rows)).toEqual([]);
    });

    it.each([
      ['INSERT', `INSERT INTO platform_ref_pushes (account_id, repo_id, run_id, runtime, ref, new_sha) VALUES ($1, $2, gen_random_uuid(), 'production', 'refs/heads/fx/x', '${sha('a')}')`],
      ['UPDATE', `UPDATE platform_ref_pushes SET new_sha = '${sha('b')}' WHERE account_id = $1 AND repo_id = $2`],
      ['DELETE', `DELETE FROM platform_ref_pushes WHERE account_id = $1 AND repo_id = $2`],
    ])('%s is refused', async (_label, sql) => {
      expect(await asTenant(refs.accountId, (c) => code(c.query(sql, [refs.accountId, refs.repoId])))).toBe('42501');
    });

    it('cannot call the function; nor can platform_ops; EXECUTE is the owner\'s and run_binding_resolver\'s alone', async () => {
      expect(await code(appPool.query(CALL, ['x', null, 'refs/heads/fx/x', sha('1'), sha('2')]))).toBe('42501');
      expect(await code(opsPool.query(CALL, ['x', null, 'refs/heads/fx/x', sha('1'), sha('2')]))).toBe('42501');
      const { rows } = await adminPool.query(
        `SELECT p.prosecdef, pg_get_userbyid(p.proowner) AS owner, p.proconfig,
                (SELECT array_agg(CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END ORDER BY 1) FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE') AS execute
           FROM pg_proc p WHERE p.proname = 'record_platform_ref_push'`,
      );
      expect(rows).toEqual([{ prosecdef: true, owner: 'platform_push_recorder', proconfig: ['search_path=pg_catalog, public, pg_temp'], execute: ['platform_push_recorder', 'run_binding_resolver'] }]);
    });
  });

  describe('createPlatformPushRecorder (the proxy\'s side)', () => {
    it('one row per branch update of a real receive-pack body; a tag and a delete in the same body write nothing', async () => {
      const r = await run();
      const body = receivePack([
        [sha('1'), sha('c'), 'refs/heads/fx/one'],
        [ZERO, sha('d'), 'refs/heads/fx/two'],
        [ZERO, sha('e'), 'refs/tags/v1'],
        [sha('f'), ZERO, 'refs/heads/fx/gone'],
      ]);
      await createPlatformPushRecorder(proxyPool)({ sandboxName: r.sandbox }, body);
      expect((await rowsOf(r.id)).map((x) => [x.ref, x.old_sha, x.new_sha])).toEqual([
        ['refs/heads/fx/one', sha('1'), sha('c')],
        ['refs/heads/fx/two', null, sha('d')],
      ]);
    });

    it('a body that does not parse whole records nothing', async () => {
      const r = await run();
      // The first update is whole; the body stops inside the second, before the flush. Nothing of it is recorded, not even the whole first line.
      const whole = Buffer.from(receivePack([[sha('1'), sha('c'), 'refs/heads/fx/one'], [sha('2'), sha('d'), 'refs/heads/fx/two']]));
      const cut = whole.indexOf(Buffer.from(`${sha('2')} ${sha('d')}`)) + 20;
      await createPlatformPushRecorder(proxyPool)({ sandboxName: r.sandbox }, whole.subarray(0, cut));
      expect(await rowsOf(r.id)).toEqual([]);
    });

    it('a runner key reaches the run by id', async () => {
      const live = await run({ runtime: 'runner', mode: 'runner_verified', sandbox: null });
      await createPlatformPushRecorder(proxyPool)({ runId: live.id }, receivePack([[sha('1'), sha('2'), 'refs/heads/fx/r']]));
      expect(await rowsOf(live.id)).toHaveLength(1);
    });

    it('a database error rejects (the proxy logs its class and the push is unaffected)', async () => {
      await expect(createPlatformPushRecorder(appPool)({ sandboxName: 'x' }, receivePack([[sha('1'), sha('2'), 'refs/heads/fx/r']]))).rejects.toMatchObject({ code: '42501' });
    });
  });
});
