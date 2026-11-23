import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deleteEngineData } from '@fx/db/src/engineBridge.js';
import { createPool } from '@fx/db/src/pool.js';
import { insertRunner } from '@fx/db/test/helpers/runnerFixtures.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { NotFoundError } from '../src/tenancy/errors.js';
import { withTenant } from '../src/tenancy/withTenant.js';
import { readEnginePlan } from '../src/engine/plan.js';

/**
 * Engine bridge EB-7 (migration 1032): chunked `plan_snapshot` events assembled into one stored snapshot per repo. Chunks are stored the way the ingest stores
 * them (an insert into engine_events, which fires the assembling trigger); the ingest door itself and the refusals in front of it are in the runner-cloud suite.
 */
describe('engine plan sync [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let opsPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;
  let sess: { a: string; b: string };
  const seqs: Record<string, number> = {};

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    sess = { a: randomUUID(), b: randomUUID() };
    for (const [k, r] of [['a', a], ['b', b]] as const) {
      const runner = await insertRunner(admin, r.accountId, r.userId);
      await admin.query(`INSERT INTO engine_bridge_settings (account_id, watch_enabled) VALUES ($1, true)`, [r.accountId]);
      await admin.query(`INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)`, [r.accountId, r.repoId]);
      await admin.query(`INSERT INTO engine_sessions (id, account_id, runner_id, repo_id, engine_instance_id, engine_version) VALUES ($1, $2, $3, $4, $5, '1.2.3')`, [sess[k], r.accountId, runner, r.repoId, randomUUID()]);
    }
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end(), opsPool.end()]);
  });

  const ref = (k: 'a' | 'b') => (k === 'a' ? a : b);
  const reset = async (k: 'a' | 'b') => {
    await admin.query(`DELETE FROM engine_plan_snapshots WHERE session_id = $1`, [sess[k]]);
    await admin.query(`DELETE FROM engine_plan_chunks WHERE session_id = $1`, [sess[k]]);
    await admin.query(`DELETE FROM engine_events WHERE session_id = $1`, [sess[k]]);
    seqs[k] = 0;
  };
  interface ChunkOpts { date?: string; count?: number; items?: object[]; roadmap?: object[]; ts?: string; seq?: number; k?: 'a' | 'b' }
  /** One `plan_snapshot` event (its own seq unless `seq` is given), as the ingest stores it. */
  const chunk = async (snap: string, index: number, o: ChunkOpts = {}) => {
    const k = o.k ?? 'a';
    const seq = o.seq ?? seqs[k]!++;
    const body = {
      plan_date: o.date ?? '2026-11-16',
      snapshot_id: snap,
      chunk_index: index,
      chunk_count: o.count ?? 2,
      items: o.items ?? [{ discussion: 100 + index, ordinal: index + 1, state: 'planned' }],
      roadmap: o.roadmap ?? [{ row_key: `${snap}-r${index}`, status: 'in_progress', planned_prs: 2 }],
    };
    await admin.query(`INSERT INTO engine_events (session_id, seq, account_id, ts, kind, body) VALUES ($1, $2, $3, $4, 'plan_snapshot', $5)`, [sess[k], seq, ref(k).accountId, o.ts ?? new Date().toISOString(), JSON.stringify(body)]);
    return seq;
  };
  const read = (k: 'a' | 'b' = 'a') => withTenant(appPool, ref(k).accountId, ref(k).userId, (c) => readEnginePlan(c, ref(k).repoId, ref(k).accountId));
  const count = async (table: string, k: 'a' | 'b' = 'a') => Number((await admin.query(`SELECT count(*) AS n FROM ${table} WHERE session_id = $1`, [sess[k]])).rows[0].n);

  it('applies a snapshot only when every chunk is here, in chunk order whatever the arrival order, and the chunks are gone afterwards', async () => {
    await reset('a');
    await chunk('s1', 2, { count: 3, items: [{ discussion: 3, ordinal: 3, state: 'merged' }], roadmap: [{ row_key: 'c', status: 'done' }] });
    await chunk('s1', 0, { count: 3, items: [{ discussion: 1, ordinal: 1, state: 'planned' }], roadmap: [{ row_key: 'a', status: 'not_started' }] });
    expect(await read()).toBeNull();
    expect(await count('engine_plan_chunks')).toBe(2);
    await chunk('s1', 1, { count: 3, items: [{ discussion: 2, ordinal: 2, state: 'pr_open' }], roadmap: [{ row_key: 'b', discussion: 2, status: 'blocked', planned_prs: 4 }] });
    const v = (await read())!;
    expect(v.items.map((i) => i.discussion)).toEqual([1, 2, 3]);
    expect(v.roadmap).toEqual([
      { row_key: 'a', discussion: null, status: 'not_started', planned_prs: null },
      { row_key: 'b', discussion: 2, status: 'blocked', planned_prs: 4 },
      { row_key: 'c', discussion: null, status: 'done', planned_prs: null },
    ]);
    expect(v.plan_date).toBe('2026-11-16');
    expect(await count('engine_plan_chunks')).toBe(0);
    expect(await count('engine_plan_snapshots')).toBe(1);
    // The events themselves stay in the log, one per chunk.
    expect(await count('engine_events')).toBe(3);
  });

  it('keeps the real roadmap keys and every real status: 1,540 rows in four chunks (bare D numbers, dotted keys, all eight statuses)', async () => {
    await reset('a');
    const statuses = ['not_started', 'in_progress', 'done', 'blocked', 'deferred', 'split', 'removed', 'superseded'];
    const rows = Array.from({ length: 1540 }, (_, i) => ({ row_key: i % 3 === 0 ? String(1000 + i) : i % 3 === 1 ? `EB-${i}.x_1` : `D.${i}-a`, discussion: 1000 + i, status: statuses[i % 8]!, planned_prs: i % 5 }));
    for (let c = 0; c < 4; c++) await chunk('real', c, { count: 4, items: [], roadmap: rows.slice(c * 500, (c + 1) * 500) });
    const v = (await read())!;
    expect(v.roadmap).toHaveLength(1540);
    expect(v.roadmap.map((r) => r.row_key)).toEqual(rows.map((r) => r.row_key));
    expect(new Set(v.roadmap.map((r) => r.status))).toEqual(new Set(statuses));
  });

  // EB-1's limits (#991): an empty row_key is valid for a bare D#N row; at most 300 items and 500 roadmap rows, counted separately. 1027's body check must accept
  // exactly what the chunk table's CHECKs accept, so these assert it first and then assemble through the same door the ingest uses.
  const baseAccepts = async (body: object) => (await admin.query(`SELECT engine_body_closed('plan_snapshot', $1::jsonb) AS ok`, [JSON.stringify(body)])).rows[0].ok as boolean;
  const snapBody = (items: object[], roadmap: object[]) => ({ plan_date: '2026-11-16', snapshot_id: 'lim', chunk_index: 0, chunk_count: 1, items, roadmap });

  it('EB-1 limits: an empty row_key (a bare D#N row) is kept as it is, never refused or dropped', async () => {
    await reset('a');
    const roadmap = [{ row_key: '', discussion: 842, status: 'in_progress' }, { row_key: 'EB-7', status: 'done' }];
    expect(await baseAccepts(snapBody([], roadmap))).toBe(true);
    await chunk('lim', 0, { count: 1, items: [], roadmap });
    expect((await read())!.roadmap).toEqual([
      { row_key: '', discussion: 842, status: 'in_progress', planned_prs: null },
      { row_key: 'EB-7', discussion: null, status: 'done', planned_prs: null },
    ]);
  });

  it('EB-1 limits: 300 items and 500 roadmap rows in one chunk are assembled whole; counted separately, not 500 combined', async () => {
    await reset('a');
    const items = Array.from({ length: 300 }, (_, i) => ({ discussion: i + 1, ordinal: i, state: 'planned' }));
    const roadmap = Array.from({ length: 500 }, (_, i) => ({ row_key: `R${i}`, status: 'not_started' }));
    expect(await baseAccepts(snapBody(items, roadmap))).toBe(true);
    await chunk('lim', 0, { count: 1, items, roadmap });
    const v = (await read())!;
    expect(v.items).toHaveLength(300);
    expect(v.roadmap).toHaveLength(500);
  });

  it('the chunk table and the ingest body check agree on the caps: 301 items or 501 roadmap rows are refused by the body check, so the trigger never meets one', async () => {
    const items = (n: number) => Array.from({ length: n }, (_, i) => ({ discussion: i + 1, ordinal: i, state: 'planned' }));
    const roadmap = (n: number) => Array.from({ length: n }, (_, i) => ({ row_key: `R${i}`, status: 'not_started' }));
    expect(await baseAccepts(snapBody(items(300), []))).toBe(true);
    expect(await baseAccepts(snapBody(items(301), []))).toBe(false);
    expect(await baseAccepts(snapBody([], roadmap(500)))).toBe(true);
    expect(await baseAccepts(snapBody([], roadmap(501)))).toBe(false);
    // And the table's own CHECKs sit at the same numbers.
    const defs = (await admin.query(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'engine_plan_chunks'::regclass AND contype = 'c'`)).rows.map((r) => r.d as string).join('\n');
    expect(defs).toMatch(/jsonb_array_length\(items\) <= 300/);
    expect(defs).toMatch(/jsonb_array_length\(roadmap\) <= 500/);
  });

  it('a snapshot larger than 1000 items or 3000 roadmap rows in all is not built and its chunks are dropped, without raising; exactly at the cap it is stored', async () => {
    const items = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ discussion: from + i + 1, ordinal: from + i, state: 'planned' }));
    const rows = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ row_key: `R${from + i}`, status: 'not_started' }));
    await reset('a');
    for (let c = 0; c < 4; c++) await chunk('big-i', c, { count: 4, items: items(c < 3 ? 300 : 101, c * 300), roadmap: [] });
    expect(await read()).toBeNull();
    expect(await count('engine_plan_snapshots')).toBe(0);
    expect(await count('engine_plan_chunks')).toBe(0);
    expect(await count('engine_events')).toBe(4);
    for (let c = 0; c < 7; c++) await chunk('big-r', c, { count: 7, items: [], roadmap: rows(c < 6 ? 500 : 1, c * 500) });
    expect(await read()).toBeNull();
    expect(await count('engine_plan_chunks')).toBe(0);
    // At the cap: 1000 items and 3000 roadmap rows are kept whole.
    for (let c = 0; c < 6; c++) await chunk('at-cap', c, { count: 6, items: c < 4 ? items(c < 3 ? 300 : 100, c * 300) : [], roadmap: rows(500, c * 500) });
    const v = (await read())!;
    expect(v.items).toHaveLength(1000);
    expect(v.roadmap).toHaveLength(3000);
  });

  it('a partial snapshot never replaces a complete one: the last whole snapshot is read, with the newer one reported as arriving', async () => {
    await reset('a');
    await chunk('whole', 0, { count: 1, items: [{ discussion: 7, ordinal: 1, state: 'planned' }] });
    await chunk('next', 0, { count: 3 });
    await chunk('next', 1, { count: 3 });
    const v = (await read())!;
    expect(v.items.map((i) => i.discussion)).toEqual([7]);
    expect(v.newer_partial).toMatchObject({ chunks_received: 2, chunk_count: 3 });
    // Whole at last: it now wins, nothing is pending, and its chunks are removed.
    await chunk('next', 2, { count: 3 });
    const w = (await read())!;
    expect(w.items.map((i) => i.discussion)).toEqual([100, 101, 102]);
    expect(w.newer_partial).toBeNull();
    expect(await count('engine_plan_chunks')).toBe(0);
  });

  it('a snapshot that never finishes is shown beside the whole one only while it is the newer; an older partial is not reported', async () => {
    await reset('a');
    await chunk('old', 0, { count: 2 });
    await chunk('done', 0, { count: 1 });
    expect((await read())!.newer_partial).toBeNull();
  });

  it('the latest complete snapshot wins, per date and across dates; a later snapshot of the same date replaces its earlier one', async () => {
    await reset('a');
    await chunk('d1', 0, { count: 1, date: '2026-11-15', items: [{ discussion: 1, ordinal: 1, state: 'merged' }] });
    await chunk('d2', 0, { count: 1, date: '2026-11-16', items: [{ discussion: 2, ordinal: 1, state: 'planned' }] });
    expect((await read())!.plan_date).toBe('2026-11-16');
    await chunk('d3', 0, { count: 1, date: '2026-11-16', items: [{ discussion: 3, ordinal: 1, state: 'planned' }] });
    expect(await count('engine_plan_snapshots')).toBe(2);
    expect((await read())!.items.map((i) => i.discussion)).toEqual([3]);
    // A snapshot of an earlier date that is completed last is the latest one received, so it is what is read.
    await chunk('d4', 0, { count: 1, date: '2026-11-15', items: [{ discussion: 4, ordinal: 1, state: 'planned' }] });
    expect((await read())!.items.map((i) => i.discussion)).toEqual([4]);
  });

  it('a snapshot of an earlier date that started before a stored one and finishes after it is dropped too: the straggler guard holds across dates', async () => {
    await reset('a');
    await chunk('old-day', 0, { count: 2, date: '2026-11-15', items: [{ discussion: 1, ordinal: 1, state: 'planned' }] });
    await chunk('new-day', 0, { count: 1, date: '2026-11-16', items: [{ discussion: 2, ordinal: 1, state: 'planned' }] });
    await chunk('old-day', 1, { count: 2, date: '2026-11-15', items: [{ discussion: 1, ordinal: 2, state: 'planned' }] });
    expect(await count('engine_plan_snapshots')).toBe(1);
    const v = (await read())!;
    expect(v.plan_date).toBe('2026-11-16');
    expect(v.items.map((i) => i.discussion)).toEqual([2]);
    expect(await count('engine_plan_chunks')).toBe(0);
  });

  it('an older snapshot whose last chunk straggles in after a newer one was stored is dropped, not put over it', async () => {
    await reset('a');
    await chunk('slow', 0, { count: 2, items: [{ discussion: 1, ordinal: 1, state: 'planned' }] });
    await chunk('fast', 0, { count: 2, items: [{ discussion: 2, ordinal: 1, state: 'planned' }] });
    await chunk('fast', 1, { count: 2, items: [{ discussion: 2, ordinal: 2, state: 'planned' }] });
    await chunk('slow', 1, { count: 2, items: [{ discussion: 1, ordinal: 2, state: 'planned' }] });
    expect((await read())!.items.map((i) => i.discussion)).toEqual([2, 2]);
    expect(await count('engine_plan_chunks')).toBe(0);
  });

  it('a resend of a stored snapshot adds nothing; a chunk that disagrees with the first on the size or the date is not kept; a repeated chunk index is not counted twice', async () => {
    await reset('a');
    await chunk('x', 0, { count: 2 });
    await chunk('x', 0, { count: 2 });
    expect(await read()).toBeNull();
    await chunk('x', 1, { count: 5 });
    await chunk('x', 1, { count: 2, date: '2026-11-01' });
    expect(await count('engine_plan_chunks')).toBe(1);
    await chunk('x', 1, { count: 2 });
    expect(await read()).not.toBeNull();
    const before = await count('engine_plan_chunks');
    await chunk('x', 1, { count: 2 });
    expect(await count('engine_plan_chunks')).toBe(before);
    expect(await count('engine_plan_snapshots')).toBe(1);
  });

  it('a date that matches the pattern but is not a date keeps the event and builds nothing, and does not raise', async () => {
    await reset('a');
    await chunk('bad', 0, { count: 1, date: '2026-13-45' });
    expect(await count('engine_events')).toBe(1);
    expect(await count('engine_plan_snapshots')).toBe(0);
    expect(await count('engine_plan_chunks')).toBe(0);
  });

  it('L2: the age is derived on read from the snapshot time; a time in the future is held at now', async () => {
    await reset('a');
    await chunk('age', 0, { count: 1, ts: new Date(Date.now() + 3_600_000).toISOString() });
    const fresh = (await read())!;
    expect(fresh.age_s).toBeLessThan(5);
    expect(new Date(fresh.snapshot_at).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    await admin.query(`UPDATE engine_plan_snapshots SET snapshot_at = now() - interval '2 hours' WHERE session_id = $1`, [sess.a]);
    const old = (await read())!;
    expect(old.age_s).toBeGreaterThanOrEqual(7199);
    expect(old.age_s).toBeLessThan(7300);
    expect(old.freshness?.session_id).toBe(sess.a);
  });

  it('reads as not found for a repo that is not ticked and for another account\'s repo; none yet is null', async () => {
    await reset('a');
    expect(await read()).toBeNull();
    await expect(withTenant(appPool, a.accountId, a.userId, (c) => readEnginePlan(c, b.repoId, a.accountId))).rejects.toBeInstanceOf(NotFoundError);
    await admin.query(`DELETE FROM engine_bridge_repos WHERE repo_id = $1`, [a.repoId]);
    try {
      await expect(read()).rejects.toBeInstanceOf(NotFoundError);
    } finally {
      await admin.query(`INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)`, [a.accountId, a.repoId]);
    }
  });

  it('row security: each account reads only its own snapshots and chunks, and app_user cannot write either table', async () => {
    await reset('a');
    await reset('b');
    await chunk('own', 0, { count: 1, k: 'a' });
    await chunk('other', 0, { count: 2, k: 'b' });
    const seen = async (who: SeedRefs, table: string) => (await withTenant(appPool, who.accountId, who.userId, (c) => c.query(`SELECT session_id FROM ${table}`))).rows.map((r) => r.session_id);
    expect(await seen(a, 'engine_plan_snapshots')).toEqual([sess.a]);
    expect(await seen(a, 'engine_plan_chunks')).toEqual([]);
    expect(await seen(b, 'engine_plan_snapshots')).toEqual([]);
    expect(await seen(b, 'engine_plan_chunks')).toEqual([sess.b]);
    expect(await read('b')).toBeNull();
    for (const sql of [
      `INSERT INTO engine_plan_snapshots (account_id, session_id, repo_id, plan_date, snapshot_id, chunk_count, items, roadmap, started_seq, completed_seq, snapshot_at) VALUES ($1, $2, $3, '2026-11-16', 'x', 1, '[]', '[]', 0, 0, now())`,
      `UPDATE engine_plan_snapshots SET items = '[]'`,
      `DELETE FROM engine_plan_snapshots`,
      `DELETE FROM engine_plan_chunks`,
    ]) {
      await expect(withTenant(appPool, a.accountId, a.userId, (c) => c.query(sql, sql.startsWith('INSERT') ? [a.accountId, sess.a, a.repoId] : [])), sql).rejects.toMatchObject({ code: '42501' });
    }
    expect(await count('engine_plan_snapshots')).toBe(1);
  });

  it('the owner\'s "Delete engine data" removes the snapshots and the unfinished chunks with the sessions', async () => {
    await reset('a');
    await chunk('gone', 0, { count: 1 });
    await chunk('half', 0, { count: 2 });
    expect(await count('engine_plan_snapshots')).toBe(1);
    expect(await count('engine_plan_chunks')).toBe(1);
    const n = await withTenant(appPool, a.accountId, a.userId, (c) => deleteEngineData(c));
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await count('engine_plan_snapshots')).toBe(0);
    expect(await count('engine_plan_chunks')).toBe(0);
    // b is untouched.
    expect(await count('engine_plan_chunks', 'b')).toBe(1);
  });

  it('prune: snapshots and unfinished chunks received over 14 days ago go, in batches, and nothing newer; only platform_ops may call it', async () => {
    await reset('b');
    await chunk('p-old', 0, { count: 1, date: '2026-10-01', k: 'b' });
    await chunk('p-mid', 0, { count: 1, date: '2026-10-20', k: 'b' });
    await chunk('p-new', 0, { count: 1, date: '2026-11-16', k: 'b' });
    await chunk('c-old', 0, { count: 2, k: 'b' });
    await chunk('c-new', 0, { count: 2, k: 'b' });
    await admin.query(`UPDATE engine_plan_snapshots SET received_at = now() - interval '15 days' WHERE session_id = $1 AND snapshot_id = 'p-old'`, [sess.b]);
    await admin.query(`UPDATE engine_plan_snapshots SET received_at = now() - interval '13 days' WHERE session_id = $1 AND snapshot_id = 'p-mid'`, [sess.b]);
    await admin.query(`UPDATE engine_plan_chunks SET received_at = now() - interval '14 days 1 hour' WHERE session_id = $1 AND snapshot_id = 'c-old'`, [sess.b]);
    const prune = async (n: number) => Number((await opsPool.query(`SELECT engine_plan_prune($1::int) AS n`, [n])).rows[0].n);
    expect(await prune(1)).toBe(1);
    expect(await prune(10)).toBe(1);
    expect(await prune(10)).toBe(0);
    const left = (await admin.query(`SELECT snapshot_id FROM engine_plan_snapshots WHERE session_id = $1 ORDER BY snapshot_id`, [sess.b])).rows.map((r) => r.snapshot_id);
    expect(left).toEqual(['p-mid', 'p-new']);
    expect((await admin.query(`SELECT snapshot_id FROM engine_plan_chunks WHERE session_id = $1`, [sess.b])).rows.map((r) => r.snapshot_id)).toEqual(['c-new']);
    await expect(opsPool.query(`SELECT engine_plan_prune(0)`)).rejects.toMatchObject({ code: '22023' });
    await expect(appPool.query(`SELECT engine_plan_prune(10)`)).rejects.toMatchObject({ code: '42501' });
  });
});
