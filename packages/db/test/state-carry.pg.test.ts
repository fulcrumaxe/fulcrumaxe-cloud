import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { insertRunner } from './helpers/runnerFixtures.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

/**
 * D#845 MC-9b2a (migration 1123): the state carry's tables and definers on real Postgres with row security forced. Runner definers run only in the runner's own session and only on its own delivered job;
 * person definers only for an owner or admin; the sweep and the start guard are engine_start_definer's. A job's state is set as the admin role, exactly as the report definers would leave it.
 */
const MIB4 = 4194304;
const SHA = (n: number): string => n.toString(16).padStart(64, '0');
const BUF = Buffer.from('sealed-bytes');

describe('state carry (1123) [pg]', () => {
  let adminPool: Pool;
  let appPool: Pool;
  let opsPool: Pool;
  let admin: PoolClient;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    admin = await adminPool.connect();
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end(), opsPool.end()]);
  });

  interface Rig { a: SeedRefs; from: string; to: string; cleanup: string; carry: string; member: string }
  const person = <T>(r: { a: SeedRefs }, fn: (c: PoolClient) => Promise<T>, userId = r.a.userId): Promise<T> => withTenant(appPool, r.a.accountId, userId, fn);
  const runner = <T>(r: { a: SeedRefs }, runnerId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> =>
    withTenant(appPool, r.a.accountId, async (c) => {
      await c.query(`SELECT set_config('app.runner_id', $1, true)`, [runnerId]);
      return fn(c);
    });
  /**
   * The issue time of a cleanup job signed straight after the rig. The definer refuses an issue time
   * before the cleanup's request time, and a JS Date is truncated to the millisecond while the request
   * time keeps microseconds, so `new Date()` can land a fraction of a millisecond early on a fast run.
   * Two seconds ahead stays inside the minute the definer allows.
   */
  const issueTime = (): Date => new Date(Date.now() + 2000);
  const code = async (p: Promise<unknown>): Promise<string> => p.then(() => 'ok', (e: { code: string; message: string }) => `${e.code}`);

  /** An account whose repo moved from `from` to `to`, with the move's cleanup and an open carry. */
  async function rig(): Promise<Rig> {
    const a = await seedAccount(admin, randomUUID());
    const from = await insertRunner(admin, a.accountId, a.userId);
    const to = await insertRunner(admin, a.accountId, a.userId);
    const member = randomUUID();
    await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [member, `${member}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [a.accountId, member]);
    await admin.query(`INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'person')`, [a.repoId, a.accountId, to]);
    const cleanup = await person({ a }, async (c) => (await c.query('SELECT machine_cleanup_request_move($1, $2) AS id', [a.repoId, from])).rows[0].id);
    const carry = await person({ a }, async (c) => (await c.query('SELECT state_carry_request($1, $2) AS id', [cleanup, to])).rows[0].id);
    return { a, from, to, cleanup, carry, member };
  }

  /** A second repo of the same account, moved the same way, with its own cleanup and open carry. */
  let offset = 0;
  async function second(r: Rig): Promise<{ repoId: string; ghRepoId: number; cleanup: string; carry: string; from: string; to: string }> {
    const from = await insertRunner(admin, r.a.accountId, r.a.userId);
    const to = await insertRunner(admin, r.a.accountId, r.a.userId);
    const repoId = randomUUID();
    offset += 1000;
    const { rows } = await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) SELECT $1, account_id, installation_id, gh_repo_id + $3, product, 'acme', 'gadgets' FROM repos WHERE id = $2 RETURNING gh_repo_id`, [repoId, r.a.repoId, 7000 + offset]);
    await admin.query(`INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'person')`, [repoId, r.a.accountId, to]);
    const cleanup = await person(r, async (c) => (await c.query('SELECT machine_cleanup_request_move($1, $2) AS id', [repoId, from])).rows[0].id);
    const carry = await person(r, async (c) => (await c.query('SELECT state_carry_request($1, $2) AS id', [cleanup, to])).rows[0].id);
    return { repoId, ghRepoId: Number(rows[0].gh_repo_id), cleanup, carry, from, to };
  }
  /** A runner session that also names an owner (a session no route builds): the person definers still refuse it. */
  const personAsRunner = <T>(r: Rig, fn: (c: PoolClient) => Promise<T>): Promise<T> =>
    person(r, async (c) => {
      await c.query(`SELECT set_config('app.runner_id', $1, true)`, [r.from]);
      return fn(c);
    });
  /** platform_ops with an account and an owner named in the session: the person definers still refuse it. */
  async function opsAsPerson(r: Rig, sql: string, args: unknown[]): Promise<string> {
    const c = await opsPool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.account_id', $1, true), set_config('app.user_id', $2, true)`, [r.a.accountId, r.a.userId]);
      return await code(c.query(sql, args));
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }

  /** A job row as the cloud would leave it, `delivered` unless said otherwise. */
  async function job(r: Rig, kind: 'engine_session_stop' | 'engine_session_start', runnerId: string, args: Record<string, unknown>, state = 'delivered', agoMin = 0): Promise<string> {
    const id = randomUUID();
    const issued = new Date(Date.now() - agoMin * 60_000);
    const expires = new Date(issued.getTime() + 600_000);
    const body = { job: { job_id: id, kind, runner_id: runnerId, issued_at: issued.toISOString(), expires_at: expires.toISOString(), args } };
    await admin.query(`SET session_replication_role = replica`);
    try {
      await admin.query(
        `INSERT INTO machine_jobs (id, account_id, runner_id, repo_id, setup_id, kind, job, issued_at, expires_at) VALUES ($1, $2, $3, $4, NULL, $5, $6::jsonb, $7, $8)`,
        [id, r.a.accountId, runnerId, r.a.repoId, kind, JSON.stringify(body), issued, expires],
      );
    } finally {
      await admin.query(`RESET session_replication_role`);
    }
    if (state === 'delivered') {
      // One delivered job per runner (machine_jobs_one_delivered): the runner's earlier one is superseded.
      await admin.query(`UPDATE machine_jobs SET state = 'superseded' WHERE account_id = $1 AND runner_id = $2 AND state = 'delivered'`, [r.a.accountId, runnerId]);
      await admin.query(`UPDATE machine_jobs SET state = 'delivered', delivered_at = issued_at WHERE id = $1`, [id]);
    }
    return id;
  }
  const stopJob = (r: Rig, runnerId = r.from, carry: string | null = r.carry) => job(r, 'engine_session_stop', runnerId, { reason: 'move', operate_epoch: 0, ...(carry ? { carry: { id: carry } } : {}) });
  const startJob = (r: Rig, carry: string = r.carry, runnerId = r.to) => job(r, 'engine_session_start', runnerId, { at_sha: 'a'.repeat(40), resume: false, operate_epoch: 0, carry: { id: carry, bytes: 1, chunks: 1, sha256: SHA(1) } });
  const row = async (id: string) => (await admin.query('SELECT * FROM state_carries WHERE id = $1', [id])).rows[0];
  const chunkCount = async (id: string) => (await admin.query('SELECT count(*)::int AS n FROM state_carry_chunks WHERE carry_id = $1', [id])).rows[0].n as number;

  const begin = (r: Rig, job: string, bytes: number, chunks: number, sha = SHA(9), who = r.from) => runner(r, who, (c) => c.query('SELECT state_carry_begin($1, $2, $3, $4)', [job, bytes, chunks, sha]));
  const put = (r: Rig, job: string, idx: number, size: number, sha = SHA(100 + idx), who = r.from, ct: Buffer = BUF) =>
    runner(r, who, (c) => c.query('SELECT state_carry_chunk_put($1, $2, $3, $4, 1, $5, $6, $7)', [job, idx, size, sha, Buffer.from('nonce'), Buffer.from('dek'), ct]));
  const seal = (r: Rig, job: string, who = r.from) => runner(r, who, (c) => c.query('SELECT state_carry_seal($1)', [job]));
  const take = (r: Rig, job: string, idx: number, who = r.to) => runner(r, who, (c) => c.query('SELECT * FROM state_carry_chunk_take($1, $2)', [job, idx]));
  const imported = (r: Rig, job: string, who = r.to) => runner(r, who, (c) => c.query('SELECT state_carry_imported($1)', [job]));
  const sweep = () => opsPool.query('SELECT state_carry_sweep() AS n').then((x) => x.rows[0].n as number);

  /** Two chunks (4 MiB and 5 bytes), sealed, with a start job delivered to the target. */
  async function sealed(r: Rig): Promise<{ stop: string; start: string }> {
    const stop = await stopJob(r);
    await begin(r, stop, MIB4 + 5, 2);
    await put(r, stop, 0, MIB4);
    await put(r, stop, 1, 5);
    await seal(r, stop);
    return { stop, start: await startJob(r) };
  }

  describe('the stop uploads: runner and tenant scoping', () => {
    it('stores the begin, the chunks and the seal for the source machine on its delivered stop', async () => {
      const r = await rig();
      const stop = await stopJob(r);
      await begin(r, stop, MIB4 + 5, 2, SHA(7));
      await begin(r, stop, MIB4 + 5, 2, SHA(7));
      expect(await row(r.carry)).toMatchObject({ bytes: MIB4 + 5, chunks: 2, sha256: SHA(7), sealed_at: null });
      await put(r, stop, 0, MIB4);
      await put(r, stop, 1, 5);
      await seal(r, stop);
      expect((await row(r.carry)).sealed_at).not.toBeNull();
      expect(await chunkCount(r.carry)).toBe(2);
    });

    it('refuses every other runner, a start job, an issued or expired stop, a stop of another carry, and another account (22023)', async () => {
      const r = await rig();
      const other = await rig();
      const stop = await stopJob(r);
      const otherStop = await stopJob(other);
      const cases: Array<[string, () => Promise<unknown>]> = [
        ['the target machine on the stop', () => begin(r, stop, 5, 1, SHA(9), r.to)],
        ['a stop of the other account', () => begin(r, otherStop, 5, 1)],
        ['the other account on this stop', () => runner(other, other.from, (c) => c.query('SELECT state_carry_begin($1, 5, 1, $2)', [stop, SHA(9)]))],
        ['a start job', async () => begin(r, await startJob(r), 5, 1, SHA(9), r.to)],
        ['a start job of the source machine', async () => begin(r, await startJob(r, r.carry, r.from), 5, 1)],
        ['a stop job of the target machine, from the source machine', async () => begin(r, await stopJob(r, r.to), 5, 1)],
        ['an issued stop', async () => begin(r, await job(r, 'engine_session_stop', r.from, { reason: 'move', operate_epoch: 0, carry: { id: r.carry } }, 'issued'), 5, 1)],
        ['no such job', () => begin(r, randomUUID(), 5, 1)],
        ['a stop of another carry', async () => begin(r, await stopJob(r, r.from, randomUUID()), 5, 1)],
        ['a stop without the carry', async () => begin(r, await stopJob(r, r.from, null), 5, 1)],
      ];
      for (const [label, p] of cases) expect(await code(p()), label).toBe('22023');
      const own = await stopJob(r);
      await admin.query(`UPDATE machine_jobs SET state = 'expired' WHERE id = $1`, [own]);
      expect(await code(begin(r, own, 5, 1))).toBe('22023');
      const lapsed = await job(r, 'engine_session_stop', r.from, { reason: 'move', operate_epoch: 0, carry: { id: r.carry } }, 'delivered', 20);
      expect(await code(begin(r, lapsed, 5, 1))).toBe('22023');
      expect((await row(r.carry)).begun_at).toBeNull();
      expect((await row(other.carry)).begun_at).toBeNull();
    });

    it('refuses a session that is no runner, a person and platform_ops (42501 or 22023)', async () => {
      const r = await rig();
      const stop = await stopJob(r);
      expect(await code(person(r, (c) => c.query('SELECT state_carry_begin($1, 5, 1, $2)', [stop, SHA(9)])))).toBe('42501');
      expect(await code(opsPool.query('SELECT state_carry_begin($1, 5, 1, $2)', [stop, SHA(9)]))).toBe('42501');
      expect(await code(runner(r, randomUUID(), (c) => c.query('SELECT state_carry_begin($1, 5, 1, $2)', [stop, SHA(9)])))).toBe('42501');
      const revoked = await insertRunner(admin, r.a.accountId, r.a.userId);
      await admin.query('UPDATE runners SET revoked_at = now() WHERE id = $1', [revoked]);
      expect(await code(runner(r, revoked, (c) => c.query('SELECT state_carry_begin($1, 5, 1, $2)', [stop, SHA(9)])))).toBe('42501');
    });
  });

  describe('caps and the sha256 bookkeeping', () => {
    it('caps the bundle at 50 MiB in at most 13 chunks that add up, and the whole sha256 as 64 hex', async () => {
      const r = await rig();
      const stop = await stopJob(r);
      for (const [bytes, chunks, sha] of [[52428801, 13, SHA(9)], [0, 1, SHA(9)], [-1, 1, SHA(9)], [MIB4 + 1, 1, SHA(9)], [MIB4, 2, SHA(9)], [0, 0, SHA(9)], [5, 1, 'ABC'], [5, 1, SHA(9).toUpperCase().replace(/0/g, 'A')]] as const) {
        expect(await code(begin(r, stop, bytes, chunks, sha)), `${bytes}/${chunks}`).toBe('22023');
      }
      expect(await code(begin(r, stop, 52428800, 13))).toBe('ok');
      expect((await row(r.carry)).chunks).toBe(13);
    });

    it('keeps the declared whole sha256 and sizes once begun: another declaration is refused, the same one is a no-op', async () => {
      const r = await rig();
      const stop = await stopJob(r);
      await begin(r, stop, 5, 1, SHA(1));
      for (const [bytes, chunks, sha] of [[6, 1, SHA(1)], [5, 1, SHA(2)]] as const) expect(await code(begin(r, stop, bytes, chunks, sha))).toBe('22023');
      const before = await row(r.carry);
      await begin(r, stop, 5, 1, SHA(1));
      expect((await row(r.carry)).begun_at).toEqual(before.begun_at);
    });

    it('takes a chunk only at its place with its exact size, and a chunk sha256 as 64 hex', async () => {
      const r = await rig();
      const stop = await stopJob(r);
      expect(await code(put(r, stop, 0, MIB4))).toBe('22023');
      await begin(r, stop, MIB4 + 5, 2);
      for (const [idx, size] of [[0, MIB4 - 1], [0, MIB4 + 1], [0, 5], [1, MIB4], [1, 4], [2, 5], [-1, MIB4], [12, 5]] as const) expect(await code(put(r, stop, idx, size)), `${idx}/${size}`).toBe('22023');
      expect(await code(put(r, stop, 0, MIB4, 'nothex'))).toBe('23514');
      expect(await code(put(r, stop, 0, MIB4, SHA(1), r.from, Buffer.alloc(MIB4 + 1025)))).toBe('23514');
      expect(await chunkCount(r.carry)).toBe(0);
      expect(await code(put(r, stop, 0, MIB4))).toBe('ok');
    });

    it('treats the same chunk sha256 as a no-op and another one before the seal as a replacement', async () => {
      const r = await rig();
      const stop = await stopJob(r);
      await begin(r, stop, 5, 1);
      await put(r, stop, 0, 5, SHA(1), r.from, Buffer.from('first'));
      const at = (await admin.query('SELECT uploaded_at FROM state_carry_chunks WHERE carry_id = $1', [r.carry])).rows[0].uploaded_at;
      await put(r, stop, 0, 5, SHA(1), r.from, Buffer.from('again'));
      expect((await admin.query('SELECT ciphertext, uploaded_at FROM state_carry_chunks WHERE carry_id = $1', [r.carry])).rows[0]).toEqual({ ciphertext: Buffer.from('first'), uploaded_at: at });
      await put(r, stop, 0, 5, SHA(2), r.from, Buffer.from('other'));
      expect((await admin.query('SELECT sha256, ciphertext FROM state_carry_chunks WHERE carry_id = $1', [r.carry])).rows).toEqual([{ sha256: SHA(2), ciphertext: Buffer.from('other') }]);
      await seal(r, stop);
      expect(await code(put(r, stop, 0, 5, SHA(3)))).toBe('22023');
      expect(await code(put(r, stop, 0, 5, SHA(2)))).toBe('22023');
      expect(await code(begin(r, stop, 5, 1, SHA(9)))).toBe('22023');
    });

    it('seals only with every index present and the sizes adding up, and once', async () => {
      const r = await rig();
      const stop = await stopJob(r);
      expect(await code(seal(r, stop))).toBe('22023');
      await begin(r, stop, MIB4 + 5, 2);
      await put(r, stop, 0, MIB4);
      expect(await code(seal(r, stop))).toBe('22023');
      await put(r, stop, 1, 5);
      await admin.query(`UPDATE state_carry_chunks SET size = size - 1 WHERE carry_id = $1 AND idx = 1`, [r.carry]);
      expect(await code(seal(r, stop))).toBe('22023');
      await admin.query(`UPDATE state_carry_chunks SET size = size + 1 WHERE carry_id = $1 AND idx = 1`, [r.carry]);
      expect(await code(seal(r, stop))).toBe('ok');
      expect(await code(seal(r, stop))).toBe('22023');
    });

    it('records an export failure (too_large, link, export_failed) and drops the content; the carry stays open', async () => {
      const r = await rig();
      const stop = await stopJob(r);
      await begin(r, stop, 5, 1);
      await put(r, stop, 0, 5);
      expect(await code(runner(r, r.from, (c) => c.query(`SELECT state_carry_fail($1, 'expired')`, [stop])))).toBe('22023');
      await runner(r, r.from, (c) => c.query(`SELECT state_carry_fail($1, 'link')`, [stop]));
      expect(await row(r.carry)).toMatchObject({ failure_code: 'link', closed_at: null, sealed_at: null });
      expect(await chunkCount(r.carry)).toBe(0);
      expect(await code(begin(r, stop, 5, 1))).toBe('22023');
      expect(await code(runner(r, r.to, (c) => c.query(`SELECT state_carry_fail($1, 'link')`, [stop])))).toBe('22023');
    });

    it('does not record a failure on a sealed carry', async () => {
      const r = await rig();
      const { stop } = await sealed(r);
      expect(await code(runner(r, r.from, (c) => c.query(`SELECT state_carry_fail($1, 'link')`, [stop])))).toBe('22023');
      expect(await chunkCount(r.carry)).toBe(2);
    });

    it('keeps the table to its own limits whatever a definer says (admin writes)', async () => {
      const r = await rig();
      const stop = await stopJob(r);
      await begin(r, stop, MIB4 + 5, 2);
      const chunk = (cols: Record<string, unknown>) => {
        const v = { idx: 0, size: 5, sha256: SHA(1), kek_version: 1, nonce: Buffer.from('n'), wrapped_dek: Buffer.from('d'), ciphertext: BUF, ...cols };
        return admin.query(`INSERT INTO state_carry_chunks (account_id, carry_id, idx, size, sha256, kek_version, nonce, wrapped_dek, ciphertext) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [r.a.accountId, r.carry, v.idx, v.size, v.sha256, v.kek_version, v.nonce, v.wrapped_dek, v.ciphertext]);
      };
      for (const bad of [{ idx: 13 }, { idx: -1 }, { size: 0 }, { size: MIB4 + 1 }, { sha256: 'xyz' }, { kek_version: 0 }, { nonce: Buffer.alloc(0) }, { wrapped_dek: Buffer.alloc(513) }, { ciphertext: Buffer.alloc(MIB4 + 1025) }]) {
        expect(await code(chunk(bad)), JSON.stringify(Object.keys(bad))).toBe('23514');
      }
      expect(await code(chunk({ idx: 12 }))).toBe('ok');
      const upd = (set: string, v: unknown[]) => admin.query(`UPDATE state_carries SET ${set} WHERE id = $1`, [r.carry, ...v]);
      expect(await code(upd('bytes = 52428801, chunks = 13', []))).toBe('23514');
      expect(await code(upd('bytes = 5, chunks = 2', []))).toBe('23514');
      expect(await code(upd('sha256 = $2', ['nothex']))).toBe('23514');
      expect(await code(upd('sha256 = NULL', []))).toBe('23514');
      expect(await code(upd('closed_at = now()', []))).toBe('23514');
      expect(await code(upd('from_runner_id = to_runner_id', []))).toBe('23514');
    });
  });

  describe('the carry id of an upload job (state_carry_job_carry)', () => {
    const jobCarry = (r: Rig, who: string, jobId: string) => runner(r, who, async (c) => (await c.query('SELECT state_carry_job_carry($1) AS id', [jobId])).rows[0].id as string);

    it('returns the carry the delivered stop of the session runner names, and refuses anything else (22023)', async () => {
      const r = await rig();
      const other = await rig();
      const stop = await stopJob(r);
      expect(await jobCarry(r, r.from, stop)).toBe(r.carry);
      const otherStop = await stopJob(other);
      expect(await jobCarry(other, other.from, otherStop)).toBe(other.carry);
      const cases: Array<[string, () => Promise<unknown>]> = [
        ['the target machine', () => jobCarry(r, r.to, stop)],
        ['another account runner', () => jobCarry(other, other.from, stop)],
        ['a job of another account', () => jobCarry(r, r.from, otherStop)],
        ['a start job', async () => jobCarry(r, r.to, await startJob(r))],
        ['a stop of another carry', async () => jobCarry(r, r.from, await stopJob(r, r.from, randomUUID()))],
        ['no such job', () => jobCarry(r, r.from, randomUUID())],
        ['an issued stop', async () => jobCarry(r, r.from, await job(r, 'engine_session_stop', r.from, { reason: 'move', operate_epoch: 0, carry: { id: r.carry } }, 'issued'))],
      ];
      for (const [label, p] of cases) expect(await code(p()), label).toBe('22023');
      const done = await stopJob(r);
      await admin.query(`UPDATE machine_jobs SET state = 'superseded' WHERE id = $1`, [done]);
      expect(await code(jobCarry(r, r.from, done))).toBe('22023');
      expect(await code(person(r, (c) => c.query('SELECT state_carry_job_carry($1)', [stop])))).toBe('42501');
    });

    it('serves a chunk with the id of the carry it now belongs to, even when its row was moved to another carry of the account', async () => {
      const r = await rig();
      const twin = await second(r);
      const { start } = await sealed(r);
      await admin.query(`UPDATE state_carries SET begun_at = now(), bytes = 5, chunks = 1, sha256 = $2, sealed_at = now() WHERE id = $1`, [twin.carry, SHA(2)]);
      await admin.query(`UPDATE state_carry_chunks SET carry_id = $2 WHERE carry_id = $1 AND idx = 0`, [r.carry, twin.carry]);
      const twinStart = await job({ ...r, from: twin.from, to: twin.to } as Rig, 'engine_session_start', twin.to, { at_sha: 'a'.repeat(40), resume: false, operate_epoch: 0, carry: { id: twin.carry, bytes: 5, chunks: 1, sha256: SHA(2) } });
      const moved = await runner(r, twin.to, (c) => c.query('SELECT * FROM state_carry_chunk_take($1, 0)', [twinStart]));
      expect(moved.rows[0].o_carry_id).toBe(twin.carry);
      expect(await code(take(r, start, 0))).toBe('22023');
    });
  });

  describe('the start fetches: once per job, and the content goes on import', () => {
    it('serves a chunk once per start job, again to a later job, and only to the target machine on its own delivered start', async () => {
      const r = await rig();
      const other = await rig();
      const { start } = await sealed(r);
      expect((await take(r, start, 0)).rows[0]).toMatchObject({ o_size: MIB4, o_sha256: SHA(100), o_kek_version: 1, o_ciphertext: BUF, o_carry_id: r.carry });
      expect(await code(take(r, start, 0))).toBe('55000');
      expect(await code(take(r, start, 1))).toBe('ok');
      const again = await startJob(r);
      expect(await code(take(r, again, 0))).toBe('ok');
      const cases: Array<[string, () => Promise<unknown>]> = [
        ['the source machine', () => take(r, again, 1, r.from)],
        ['the other account', () => runner(other, other.to, (c) => c.query('SELECT * FROM state_carry_chunk_take($1, 1)', [again]))],
        ['a stop job', async () => take(r, await stopJob(r), 1, r.from)],
        ['a chunk that is not there', () => take(r, again, 2)],
        ['a person', () => person(r, (c) => c.query('SELECT * FROM state_carry_chunk_take($1, 1)', [again]))],
      ];
      for (const [label, p] of cases) expect(await code(p()), label).toBe(label === 'a person' ? '42501' : '22023');
    });

    it('serves nothing before the seal or after a failure, and imports neither', async () => {
      const r = await rig();
      const stop = await stopJob(r);
      await begin(r, stop, 5, 1);
      await put(r, stop, 0, 5);
      const early = await startJob(r);
      expect(await code(take(r, early, 0))).toBe('22023');
      expect(await code(imported(r, early))).toBe('22023');
      await seal(r, stop);
      expect(await code(take(r, early, 0))).toBe('ok');
      await admin.query(`UPDATE state_carries SET failure_code = 'expired' WHERE id = $1`, [r.carry]);
      const later = await startJob(r);
      expect(await code(take(r, later, 0))).toBe('22023');
      expect(await code(imported(r, later))).toBe('22023');
    });

    it('deletes every content row on import, keeps the header closed as imported, and answers a second import quietly', async () => {
      const r = await rig();
      const { start } = await sealed(r);
      const wrong = await startJob(r, r.carry, r.from);
      expect(await code(imported(r, wrong, r.from))).toBe('22023');
      await imported(r, start);
      expect(await chunkCount(r.carry)).toBe(0);
      expect(await row(r.carry)).toMatchObject({ closed_reason: 'imported', bytes: MIB4 + 5, sha256: SHA(9) });
      expect((await row(r.carry)).closed_at).not.toBeNull();
      expect(await code(imported(r, start))).toBe('ok');
      expect(await code(take(r, start, 0))).toBe('22023');
    });
  });

  describe('the start guard (trigger on machine_jobs)', () => {
    const plain = { at_sha: 'a'.repeat(40), resume: false, operate_epoch: 0 };
    /** Inserts a start with the trigger live, as `role` (the table owner when none). */
    async function insertStart(r: Rig, args: Record<string, unknown>, runnerId = r.to, role?: string): Promise<string> {
      const id = randomUUID();
      const issued = new Date();
      const expires = new Date(issued.getTime() + 600_000);
      const body = { job: { job_id: id, kind: 'engine_session_start', runner_id: runnerId, issued_at: issued.toISOString(), expires_at: expires.toISOString(), args } };
      const sql = `INSERT INTO machine_jobs (id, account_id, runner_id, repo_id, setup_id, kind, job, issued_at, expires_at) VALUES ($1, $2, $3, $4, NULL, 'engine_session_start', $5::jsonb, $6, $7)`;
      await admin.query('BEGIN');
      try {
        if (role) {
          await admin.query(`SELECT set_config('app.account_id', $1, true)`, [r.a.accountId]);
          await admin.query(`SET LOCAL ROLE ${role}`);
        }
        await admin.query(sql, [id, r.a.accountId, runnerId, r.a.repoId, JSON.stringify(body), issued, expires]);
        await admin.query('COMMIT');
      } catch (e) {
        await admin.query('ROLLBACK');
        throw e;
      }
      return id;
    }
    const carryArgs = (id: string) => ({ ...plain, carry: { id, bytes: 1, chunks: 1, sha256: SHA(1) } });

    it('refuses a start without the carry while one is open, as the table owner, the person issuer role and the system issuer role alike', async () => {
      const r = await rig();
      for (const role of [undefined, 'machine_jobs_owner', 'engine_start_definer']) expect(await code(insertStart(r, plain, r.to, role)), String(role)).toBe('55000');
      expect(await code(insertStart(r, plain, r.from))).toBe('55000');
      expect(await code(insertStart(r, carryArgs(randomUUID())))).toBe('55000');
    });

    it('refuses the own start of a carry until it is sealed and unfailed, and on any machine but its target; lets it in then', async () => {
      const r = await rig();
      expect(await code(insertStart(r, carryArgs(r.carry)))).toBe('55000');
      const stop = await stopJob(r);
      await begin(r, stop, 5, 1);
      await put(r, stop, 0, 5);
      await seal(r, stop);
      expect(await code(insertStart(r, carryArgs(r.carry), r.from))).toBe('55000');
      expect(await code(insertStart(r, carryArgs(randomUUID())))).toBe('55000');
      expect(await code(insertStart(r, plain))).toBe('55000');
      await admin.query(`UPDATE state_carries SET failure_code = 'expired' WHERE id = $1`, [r.carry]);
      expect(await code(insertStart(r, carryArgs(r.carry)))).toBe('55000');
      await admin.query(`UPDATE state_carries SET failure_code = NULL WHERE id = $1`, [r.carry]);
      expect(await code(insertStart(r, carryArgs(r.carry)))).toBe('ok');
    });

    it('lets a plain start in once the carry is closed or when the repo has none, and leaves other repos and other account alone', async () => {
      const r = await rig();
      const other = await rig();
      expect(await code(insertStart(other, plain, other.to))).toBe('55000');
      const lone = await seedAccount(admin, randomUUID());
      const lr = await insertRunner(admin, lone.accountId, lone.userId);
      expect(await code(insertStart({ ...r, a: lone }, plain, lr))).toBe('ok');
      const twin = await second(r);
      await person(r, (c) => c.query('SELECT state_carry_abandon($1)', [r.carry]));
      expect(await code(insertStart(r, plain))).toBe('ok');
      expect((await row(other.carry)).closed_at).toBeNull();
      expect((await row(twin.carry)).closed_at).toBeNull();
    });
  });

  describe('the cleanup rules (1083, re-made)', () => {
    const issue = (r: Rig, kind: string, args: Record<string, unknown>) =>
      runner(r, r.from, async (c) => {
        const id = randomUUID();
        const issued = issueTime();
        const expires = new Date(issued.getTime() + 600_000);
        const gh = (await c.query('SELECT gh_repo_id FROM repos WHERE id = $1', [r.a.repoId])).rows[0].gh_repo_id;
        const j = { job: { job_id: id, kind, runner_id: r.from, repo_gh_id: Number(gh), requires_engine: 'any', issued_at: issued.toISOString(), expires_at: expires.toISOString(), args } };
        await c.query('SELECT machine_cleanup_issue($1, $2, $3, $4::jsonb, $5, $6)', [r.cleanup, id, kind, JSON.stringify(j), issued, expires]);
      });
    const stopArgs = (carry?: unknown) => ({ reason: 'move', operate_epoch: 0, ...(carry === undefined ? {} : { carry }) });

    it('signs a stop with exactly the id of the open unsealed carry, and refuses none, another id, an extra key, a null or a bare id', async () => {
      const r = await rig();
      for (const carry of [undefined, { id: randomUUID() }, { id: r.carry, x: 1 }, null, r.carry]) expect(await code(issue(r, 'engine_session_stop', stopArgs(carry))), JSON.stringify(carry)).toBe('22023');
      expect(await code(issue(r, 'engine_session_stop', stopArgs({ id: r.carry })))).toBe('ok');
    });

    it('names the carry of the cleanup own repo when the account has two open carries', async () => {
      const r = await rig();
      const twin = await second(r);
      const issueFor = (who: string, cleanup: string, ghRepoId: number, carry: string) =>
        runner(r, who, async (c) => {
          const id = randomUUID();
          const issued = issueTime();
          const expires = new Date(issued.getTime() + 600_000);
          const j = { job: { job_id: id, kind: 'engine_session_stop', runner_id: who, repo_gh_id: ghRepoId, requires_engine: 'any', issued_at: issued.toISOString(), expires_at: expires.toISOString(), args: { reason: 'move', operate_epoch: 0, carry: { id: carry } } } };
          await c.query('SELECT machine_cleanup_issue($1, $2, $3, $4::jsonb, $5, $6)', [cleanup, id, 'engine_session_stop', JSON.stringify(j), issued, expires]);
        });
      expect(await code(issueFor(twin.from, twin.cleanup, twin.ghRepoId, twin.carry))).toBe('ok');
      const gh = Number((await admin.query('SELECT gh_repo_id FROM repos WHERE id = $1', [r.a.repoId])).rows[0].gh_repo_id);
      expect(await code(issueFor(r.from, r.cleanup, gh, twin.carry))).toBe('22023');
      expect(await code(issueFor(r.from, r.cleanup, gh, r.carry))).toBe('ok');
    });

    it('refuses a carry on a stop once the carry is sealed, and on a delete', async () => {
      const r = await rig();
      await admin.query(`UPDATE state_carries SET begun_at = now(), bytes = 5, chunks = 1, sha256 = $2, sealed_at = now() WHERE id = $1`, [r.carry, SHA(1)]);
      expect(await code(issue(r, 'engine_session_stop', stopArgs({ id: r.carry })))).toBe('22023');
      expect(await code(issue(r, 'engine_session_stop', stopArgs()))).toBe('ok');
      const d = await rig();
      expect(await code(issue(d, 'engine_session_delete', { operate_epoch: 0, carry: { id: d.carry } }))).toBe('22023');
    });

    it('keeps a move delete from being due while the cleanup has an open carry, and due again once it is closed', async () => {
      const r = await rig();
      const dueKinds = () => runner(r, r.from, async (c) => (await c.query('SELECT o_kind FROM machine_cleanup_due()')).rows.map((x) => x.o_kind as string));
      await admin.query('DELETE FROM project_placements WHERE repo_id = $1', [r.a.repoId]);
      expect(await dueKinds()).toEqual(['engine_session_stop']);
      await admin.query(`UPDATE state_carries SET closed_at = now(), closed_reason = 'cancelled' WHERE id = $1`, [r.carry]);
      expect(await dueKinds()).toEqual(['engine_session_stop', 'engine_session_delete']);
    });
  });

  describe('the person definers', () => {
    it('opens one carry per repo for the cleanup of a move to the machine it is placed on, for an owner or admin alone', async () => {
      const r = await rig();
      expect(await row(r.carry)).toMatchObject({ from_runner_id: r.from, to_runner_id: r.to, cleanup_id: r.cleanup, requested_by: r.a.userId, closed_at: null });
      const other = await insertRunner(admin, r.a.accountId, r.a.userId);
      const request = (cleanup: string, to: string, who = r.a.userId) => person(r, (c) => c.query('SELECT state_carry_request($1, $2)', [cleanup, to]), who);
      expect(await code(request(r.cleanup, r.to))).toBe('23505');
      expect(await code(request(r.cleanup, other))).toBe('22023');
      expect(await code(request(r.cleanup, r.from))).toBe('22023');
      await admin.query('UPDATE project_placements SET runner_id = $2 WHERE repo_id = $1', [r.a.repoId, r.from]);
      expect(await code(request(r.cleanup, r.from))).toBe('22023');
      await admin.query('UPDATE project_placements SET runner_id = $2 WHERE repo_id = $1', [r.a.repoId, r.to]);
      const removal = await person(r, async (c) => (await c.query('SELECT machine_cleanup_request($1, $2, true) AS id', [r.a.repoId, other])).rows[0].id as string);
      expect(await code(request(removal, r.to))).toBe('22023');
      expect(await code(request((await rig()).cleanup, r.to))).toBe('22023');
      expect(await code(request(r.cleanup, r.to, r.member))).toBe('42501');
      expect(await code(runner(r, r.from, (c) => c.query('SELECT state_carry_request($1, $2)', [r.cleanup, r.to])))).toBe('42501');
      expect(await code(opsPool.query('SELECT state_carry_request($1, $2)', [r.cleanup, r.to]))).toBe('42501');
      expect(await code(personAsRunner(r, (c) => c.query('SELECT state_carry_request($1, $2)', [r.cleanup, r.to])))).toBe('42501');
      expect(await opsAsPerson(r, 'SELECT state_carry_request($1, $2)', [r.cleanup, r.to])).toBe('42501');
      await person(r, (c) => c.query('SELECT state_carry_abandon($1)', [r.carry]));
      await admin.query('UPDATE runners SET revoked_at = now() WHERE id = $1', [r.to]);
      expect(await code(request(r.cleanup, r.to))).toBe('22023');
    });

    it('refuses abandon, retarget and retry to a member, a runner, platform_ops and another account', async () => {
      const r = await rig();
      const o = await rig();
      for (const sql of ['SELECT state_carry_abandon($1)', 'SELECT state_carry_retry($1)', 'SELECT state_carry_retarget($1, $1)']) {
        expect(await code(person(r, (c) => c.query(sql, [r.carry]), r.member)), sql).toBe('42501');
        expect(await code(runner(r, r.from, (c) => c.query(sql, [r.carry]))), sql).toBe('42501');
        expect(await code(personAsRunner(r, (c) => c.query(sql, [r.carry]))), sql).toBe('42501');
        expect(await opsAsPerson(r, sql, [r.carry]), sql).toBe('42501');
        expect(await code(opsPool.query(sql, [r.carry])), sql).toBe('42501');
      }
      expect(await code(person(o, (c) => c.query('SELECT state_carry_abandon($1)', [r.carry])))).toBe('22023');
      expect(await code(person(o, (c) => c.query('SELECT state_carry_retry($1)', [r.carry])))).toBe('22023');
      expect(await person(o, async (c) => (await c.query('SELECT state_carry_retarget($1, $2) AS ok', [r.a.repoId, r.to])).rows[0].ok)).toBe(false);
      expect((await row(r.carry)).closed_at).toBeNull();
    });

    it('abandons an open carry (content gone, header kept) and refuses a closed one', async () => {
      const r = await rig();
      await sealed(r);
      await person(r, (c) => c.query('SELECT state_carry_abandon($1)', [r.carry]));
      expect(await row(r.carry)).toMatchObject({ closed_reason: 'abandoned' });
      expect(await chunkCount(r.carry)).toBe(0);
      expect(await code(person(r, (c) => c.query('SELECT state_carry_abandon($1)', [r.carry])))).toBe('22023');
    });

    it('retargets the open carry to the machine the repo is placed on now and leaves its source; refuses the source and a revoked machine', async () => {
      const r = await rig();
      const third = await insertRunner(admin, r.a.accountId, r.a.userId);
      const retarget = (to: string) => person(r, async (c) => (await c.query('SELECT state_carry_retarget($1, $2) AS ok', [r.a.repoId, to])).rows[0].ok as boolean);
      expect(await retarget(third)).toBe(false);
      await admin.query('UPDATE project_placements SET runner_id = $2 WHERE repo_id = $1', [r.a.repoId, third]);
      expect(await retarget(third)).toBe(true);
      expect(await row(r.carry)).toMatchObject({ from_runner_id: r.from, to_runner_id: third });
      await admin.query('UPDATE project_placements SET runner_id = $2 WHERE repo_id = $1', [r.a.repoId, r.from]);
      expect(await retarget(r.from)).toBe(false);
      await admin.query('UPDATE runners SET revoked_at = now() WHERE id = $1', [r.to]);
      await admin.query('UPDATE project_placements SET runner_id = $2 WHERE repo_id = $1', [r.a.repoId, r.to]);
      expect(await retarget(r.to)).toBe(false);
      await admin.query('UPDATE project_placements SET runner_id = $2 WHERE repo_id = $1', [r.a.repoId, third]);
      await person(r, (c) => c.query('SELECT state_carry_abandon($1)', [r.carry]));
      expect(await retarget(third)).toBe(false);
      expect((await row(r.carry)).to_runner_id).toBe(third);
    });

    it('retries: closes the open carry as retried, drops its content, opens a new one for the same source and restarts the cleanup', async () => {
      const r = await rig();
      await sealed(r);
      const asked = (await admin.query('SELECT requested_at FROM machine_cleanups WHERE id = $1', [r.cleanup])).rows[0].requested_at as Date;
      const next = await person(r, async (c) => (await c.query('SELECT state_carry_retry($1) AS id', [r.carry])).rows[0].id as string);
      expect(next).not.toBe(r.carry);
      expect(await row(r.carry)).toMatchObject({ closed_reason: 'retried' });
      expect(await chunkCount(r.carry)).toBe(0);
      expect(await row(next)).toMatchObject({ from_runner_id: r.from, to_runner_id: r.to, cleanup_id: r.cleanup, begun_at: null, closed_at: null });
      expect((await admin.query('SELECT requested_at FROM machine_cleanups WHERE id = $1', [r.cleanup])).rows[0].requested_at.getTime()).toBeGreaterThan(asked.getTime());
      expect(await code(person(r, (c) => c.query('SELECT state_carry_retry($1)', [r.carry])))).toBe('22023');
    });

    it('does not retry a carry whose source was removed, or whose project is placed on its source again', async () => {
      const r = await rig();
      await admin.query(`UPDATE state_carries SET failure_code = 'source_removed' WHERE id = $1`, [r.carry]);
      expect(await code(person(r, (c) => c.query('SELECT state_carry_retry($1)', [r.carry])))).toBe('22023');
      await admin.query(`UPDATE state_carries SET failure_code = NULL WHERE id = $1`, [r.carry]);
      await admin.query('UPDATE runners SET revoked_at = now() WHERE id = $1', [r.from]);
      expect(await code(person(r, (c) => c.query('SELECT state_carry_retry($1)', [r.carry])))).toBe('22023');
      await admin.query('UPDATE runners SET revoked_at = NULL WHERE id = $1', [r.from]);
      await admin.query('UPDATE project_placements SET runner_id = $2 WHERE repo_id = $1', [r.a.repoId, r.from]);
      expect(await code(person(r, (c) => c.query('SELECT state_carry_retry($1)', [r.carry])))).toBe('22023');
      expect((await row(r.carry)).closed_at).toBeNull();
    });
  });

  describe('retention: the 24 h sweep and the 30 days of the header', () => {
    const age = (id: string, col: string, hours: number) => admin.query(`UPDATE state_carries SET ${col} = now() - make_interval(hours => $2) WHERE id = $1`, [id, hours]);

    it('marks a sealed carry expired 24 h after the seal and deletes its content, not before; the header stays open', async () => {
      const r = await rig();
      await sealed(r);
      await age(r.carry, 'sealed_at', 23);
      await sweep();
      expect(await row(r.carry)).toMatchObject({ failure_code: null });
      expect(await chunkCount(r.carry)).toBe(2);
      await age(r.carry, 'sealed_at', 25);
      await sweep();
      expect(await row(r.carry)).toMatchObject({ failure_code: 'expired', closed_at: null });
      expect(await chunkCount(r.carry)).toBe(0);
    });

    it('expires an unsealed upload begun 24 h ago, not one that has not begun', async () => {
      const r = await rig();
      const idle = await rig();
      const stop = await stopJob(r);
      await begin(r, stop, 5, 1);
      await put(r, stop, 0, 5);
      await age(idle.carry, 'requested_at', 500);
      await sweep();
      expect(await row(r.carry)).toMatchObject({ failure_code: null });
      await age(r.carry, 'begun_at', 25);
      await sweep();
      expect(await row(r.carry)).toMatchObject({ failure_code: 'expired' });
      expect(await chunkCount(r.carry)).toBe(0);
      expect(await row(idle.carry)).toMatchObject({ failure_code: null, closed_at: null });
    });

    it('marks an unsealed carry source_removed when its source machine was removed, and leaves a sealed one importable', async () => {
      const r = await rig();
      const s = await rig();
      const { start } = await sealed(s);
      await admin.query('UPDATE runners SET revoked_at = now() WHERE id = ANY ($1)', [[r.from, s.from]]);
      await sweep();
      expect(await row(r.carry)).toMatchObject({ failure_code: 'source_removed', closed_at: null });
      expect(await row(s.carry)).toMatchObject({ failure_code: null });
      expect(await code(take(s, start, 0))).toBe('ok');
    });

    it('cancels the carry of a repo that has no placement and deletes the content of every failed carry', async () => {
      const r = await rig();
      await sealed(r);
      await admin.query('DELETE FROM project_placements WHERE repo_id = $1', [r.a.repoId]);
      await sweep();
      expect(await row(r.carry)).toMatchObject({ closed_reason: 'cancelled' });
      expect(await chunkCount(r.carry)).toBe(0);
      const f = await rig();
      await sealed(f);
      await admin.query(`UPDATE state_carries SET failure_code = 'import_failed' WHERE id = $1`, [f.carry]);
      await sweep();
      expect(await chunkCount(f.carry)).toBe(0);
    });

    it('keeps a closed header 30 days and then deletes it', async () => {
      const r = await rig();
      await person(r, (c) => c.query('SELECT state_carry_abandon($1)', [r.carry]));
      await admin.query(`UPDATE state_carries SET closed_at = now() - interval '29 days' WHERE id = $1`, [r.carry]);
      await sweep();
      expect(await row(r.carry)).toBeDefined();
      await admin.query(`UPDATE state_carries SET closed_at = now() - interval '31 days' WHERE id = $1`, [r.carry]);
      await sweep();
      expect(await row(r.carry)).toBeUndefined();
    });

    it('is platform_ops alone', async () => {
      const r = await rig();
      expect(await code(person(r, (c) => c.query('SELECT state_carry_sweep()')))).toBe('42501');
      expect(await code(runner(r, r.from, (c) => c.query('SELECT state_carry_sweep()')))).toBe('42501');
      expect(await code(adminPool.query('SELECT state_carry_sweep()'))).toBe('42501');
    });
  });

  describe('grants, ownership and the account cascade', () => {
    it('gives app_user the header and the non-content chunk columns, never the content, and no write', async () => {
      const r = await rig();
      await sealed(r);
      expect(await person(r, async (c) => (await c.query('SELECT id, sha256 FROM state_carries')).rowCount)).toBe(1);
      expect(await person(r, async (c) => (await c.query('SELECT idx, size FROM state_carry_chunks')).rowCount)).toBe(2);
      expect(await runner(r, r.from, async (c) => (await c.query('SELECT id FROM state_carries')).rowCount)).toBe(1);
      expect(await runner(r, r.to, async (c) => (await c.query('SELECT id FROM state_carries')).rowCount)).toBe(0);
      expect(await runner(r, r.from, async (c) => (await c.query('SELECT idx FROM state_carry_chunks')).rowCount)).toBe(0);
      const other = await rig();
      expect(await person(other, async (c) => (await c.query('SELECT id FROM state_carries WHERE id = $1', [r.carry])).rowCount)).toBe(0);
      for (const col of ['ciphertext', 'nonce', 'wrapped_dek', 'sha256', 'kek_version', 'fetched_job_id']) expect(await code(person(r, (c) => c.query(`SELECT ${col} FROM state_carry_chunks`))), col).toBe('42501');
      expect(await code(person(r, (c) => c.query('SELECT * FROM state_carry_chunks')))).toBe('42501');
      for (const sql of [`UPDATE state_carries SET failure_code = 'link'`, 'DELETE FROM state_carries', 'DELETE FROM state_carry_chunks', `UPDATE state_carry_chunks SET size = 1`]) expect(await code(person(r, (c) => c.query(sql))), sql).toBe('42501');
      expect(await code(person(r, (c) => c.query(`INSERT INTO state_carries (account_id, repo_id, from_runner_id, to_runner_id, cleanup_id, requested_by) VALUES ($1, $2, $3, $4, $5, $6)`, [r.a.accountId, r.a.repoId, r.from, r.to, r.cleanup, r.a.userId])))).toBe('42501');
    });

    it('shapes every function: REVOKE ALL FROM PUBLIC, a pinned search_path, the owner and the grantees', async () => {
      const { rows } = await admin.query(
        `SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig,
                array_remove(ARRAY[CASE WHEN has_function_privilege('public', p.oid, 'EXECUTE') THEN 'PUBLIC' END, CASE WHEN has_function_privilege('app_user', p.oid, 'EXECUTE') THEN 'app_user' END,
                                   CASE WHEN has_function_privilege('platform_ops', p.oid, 'EXECUTE') THEN 'platform_ops' END], NULL) AS grantees
           FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'state\\_carry\\_%' ORDER BY p.proname`,
      );
      expect(rows.map((x) => x.proname)).toEqual(['state_carry_abandon', 'state_carry_begin', 'state_carry_chunk_put', 'state_carry_chunk_take', 'state_carry_fail', 'state_carry_for_job', 'state_carry_imported', 'state_carry_job_carry',
        'state_carry_person', 'state_carry_request', 'state_carry_retarget', 'state_carry_retry', 'state_carry_seal', 'state_carry_start_guard', 'state_carry_sweep']);
      for (const x of rows) {
        const invoker = ['state_carry_person', 'state_carry_for_job'].includes(x.proname);
        const ops = ['state_carry_sweep', 'state_carry_start_guard'].includes(x.proname);
        expect(x.proconfig, x.proname).toEqual(['search_path=pg_catalog, public, pg_temp']);
        expect(x.owner, x.proname).toBe(ops ? 'engine_start_definer' : 'machine_jobs_owner');
        expect(x.grantees, x.proname).toEqual(invoker ? [] : x.proname === 'state_carry_sweep' ? ['platform_ops'] : ['app_user']);
        expect(x.prosecdef, x.proname).toBe(!invoker);
      }
    });

    it('removes the carries and their content with the account', async () => {
      const r = await rig();
      await sealed(r);
      const keep = await rig();
      await sealed(keep);
      await admin.query('DELETE FROM accounts WHERE id = $1', [r.a.accountId]);
      expect((await admin.query('SELECT count(*)::int AS n FROM state_carries WHERE account_id = $1', [r.a.accountId])).rows[0].n).toBe(0);
      expect((await admin.query('SELECT count(*)::int AS n FROM state_carry_chunks WHERE account_id = $1', [r.a.accountId])).rows[0].n).toBe(0);
      expect(await chunkCount(keep.carry)).toBe(2);
    });
  });

  it('takes engine_carry_v1 into the capability list next to the thirty before it', async () => {
    const r = await rig();
    const before = ['proposal_verifier', 'wake_v1', 'plane_merge_v1', 'memory_limit_v1', 'plane_merge_queue_v1', 'discovery_analyst', 'conflict_facts_v1', 'ordered_facts_v1', 'tip_publish_v1', 'mem_proposal_v1', 'browser_chrome_v1', 'deploy_order_v1', 'browser_playwright_v1', 'overlap_facts_v1', 'engine_bridge_v1', 'sandbox_commands_v1', 'watch_mode_v1', 'kvm_fact_v1', 'preflight_v1', 'heartbeat_inventory_v1', 'device_register_v1', 'project_setup_v1', 'survey_v1', 'engine_session_v1', 'machine_login_v1', 'repo_token_refresh_v1', 'engine_lease_v1', 'survey_public_v1', 'twin_v1', 'platform_fact_v1'];
    expect(before).toHaveLength(30);
    await runner(r, r.from, (c) => c.query('SELECT runner_capabilities_record($1::text[])', [[...before, 'engine_carry_v1']]));
    expect((await admin.query('SELECT capabilities FROM runner_capabilities WHERE runner_id = $1', [r.from])).rows[0].capabilities).toEqual([...before, 'engine_carry_v1']);
    expect(await code(runner(r, r.from, (c) => c.query('SELECT runner_capabilities_record($1::text[])', [['engine_carry_v2']])))).toBe('22023');
    expect(await code(admin.query(`UPDATE runner_capabilities SET capabilities = ARRAY['engine_carry_v2'] WHERE runner_id = $1`, [r.from]))).toBe('23514');
  });
});
