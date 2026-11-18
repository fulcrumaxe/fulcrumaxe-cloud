import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deleteEngineData, readEngineBridgeSettings, readEngineRepoFreshness, readEngineSettingsView, setEngineBridgeSettings } from '../src/engineBridge.js';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { insertRunner } from './helpers/runnerFixtures.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

const ENGINE_TABLES = [
  'engine_bridge_settings',
  'engine_bridge_repos',
  'engine_sessions',
  'engine_events',
  'engine_agents',
  'engine_lanes',
  'engine_gate_receipts',
  'engine_asks',
  'engine_session_gaps',
  'engine_agent_usage',
] as const;

const SHA = 'a'.repeat(40);

/** One valid body per kind in the catalogue (v1, with the v1.1 usage fields and the v1.2 chunked snapshot). */
const VALID: Record<string, object> = {
  agent_started: { spawn_id: 'toolu_01AbC', role: 'executor', background: true, isolation: 'worktree', discussion: 12, model: 'sonnet-5' },
  agent_linked: { spawn_id: 'toolu_01AbC', agent_id: 'agent-1' },
  agent_stopped: { agent_id: 'agent-1', role: 'code-reviewer', verdict: 'pass', credential_mode: 'subscription', duration_s: 41, usage: { input: 1, output: 2, cache_read: 3, cache_write: 4 } },
  spawn_blocked: { role: 'other', reason: 'budget' },
  merge_lane: { pr: 5, state: 'queued', discussion: 3 },
  merged: { pr: 5, closes: true },
  gate_receipt: { pr: 5, gate: 'gate1', result: 'pass', head_sha: SHA },
  team_log_line: { line_id: '0123456789abcdef', actor_role: 'team-lead', category: 'merged', pr: 5 },
  loop_tick: { origin: 'cron', duration_s: 3 },
  checkin_tick: { name: 'D.100-a', origin: 'host' },
  engine_heartbeat: { origin: 'interactive', source_ages_s: { loop: 5, plan: 7 } },
  plan_snapshot: {
    plan_date: '2026-11-16',
    snapshot_id: 'snap-1',
    chunk_index: 0,
    chunk_count: 2,
    items: [{ discussion: 842, ordinal: 1, state: 'planned' }],
    roadmap: [{ row_key: '842', status: 'in_progress', planned_prs: 3 }, { row_key: 'EB-4.x_1', discussion: 842, status: 'superseded' }],
  },
  ask_raised: { ask_id: '0123456789abcdef', ask_kind: 'owner_decision', source: 'team_log' },
  ask_cleared: { ask_id: '0123456789abcdef', how: 'answered_cloud' },
  host_started: {},
  host_stopped: { reason: 'halted' },
  host_heartbeat: {},
  tick_started: { tick_kind: 'loop' },
  tick_ended: { tick_kind: 'loop', credential_mode: 'api_key', outcome: 'ok', usage: { input: 9 } },
  compaction_detected: {},
  halt_applied: { halt_epoch: 2, method: 'scope', survivors: 0 },
  bridge_heartbeat: {},
  bridge_dropped: { count: 2, reason: 'redaction' },
};

/** Engine bridge EB-4 (migration 1027): the closed event shape, row security on every table, the switches, the prune and the owner's delete. */
describe('engine bridge tables [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let opsPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;
  const ids: Record<'a' | 'b', { runner: string; session: string }> = { a: { runner: '', session: '' }, b: { runner: '', session: '' } };

  const closed = async (kind: string, body: unknown): Promise<boolean> =>
    (await admin.query('SELECT engine_body_closed($1::text, $2::jsonb) AS ok', [kind, JSON.stringify(body)])).rows[0].ok;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    for (const [k, r] of [['a', a], ['b', b]] as const) {
      ids[k].runner = await insertRunner(admin, r.accountId, r.userId);
      ids[k].session = randomUUID();
      await admin.query(`INSERT INTO engine_bridge_settings (account_id, watch_enabled) VALUES ($1, true)`, [r.accountId]);
      await admin.query(`INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)`, [r.accountId, r.repoId]);
      await admin.query(`INSERT INTO engine_sessions (id, account_id, runner_id, repo_id, engine_instance_id, engine_version) VALUES ($1, $2, $3, $4, $5, '1.2.3')`, [ids[k].session, r.accountId, ids[k].runner, r.repoId, randomUUID()]);
      const s = ids[k].session;
      await admin.query(`INSERT INTO engine_events (session_id, seq, account_id, ts, kind, body) VALUES ($1, 0, $2, now(), 'merged', '{"pr":1,"closes":false}')`, [s, r.accountId]);
      await admin.query(`INSERT INTO engine_agents (account_id, session_id, spawn_id, role) VALUES ($1, $2, 'toolu_x', 'executor')`, [r.accountId, s]);
      await admin.query(`INSERT INTO engine_lanes (account_id, session_id, pr, state, updated_at) VALUES ($1, $2, 1, 'queued', now())`, [r.accountId, s]);
      await admin.query(`INSERT INTO engine_gate_receipts (account_id, session_id, pr, gate, result, head_sha, at) VALUES ($1, $2, 1, 'gate1', 'pass', $3, now())`, [r.accountId, s, SHA]);
      await admin.query(`INSERT INTO engine_asks (account_id, session_id, ask_id, ask_kind, source, raised_at) VALUES ($1, $2, '0123456789abcdef', 'other', 'team_log', now())`, [r.accountId, s]);
      await admin.query(`INSERT INTO engine_session_gaps (account_id, session_id, from_seq, to_seq) VALUES ($1, $2, 1, 2)`, [r.accountId, s]);
      await admin.query(`INSERT INTO engine_agent_usage (account_id, session_id, subject_kind, subject_id, credential_mode) VALUES ($1, $2, 'agent', 'agent-1', 'subscription')`, [r.accountId, s]);
    }
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, appPool, opsPool]) await p.end();
  });

  describe('the closed body', () => {
    it('accepts one valid body of every kind, and the kinds listed here are every kind the table knows', async () => {
      for (const [kind, body] of Object.entries(VALID)) expect(await closed(kind, body), kind).toBe(true);
      const { rows } = await admin.query(`SELECT count(*)::int AS n FROM unnest(ARRAY[${Object.keys(VALID).map((k) => `'${k}'`).join(',')}]) k WHERE engine_kind_spec(k) IS NOT NULL`);
      expect(rows[0].n).toBe(Object.keys(VALID).length);
      expect(await closed('not_a_kind', {})).toBe(false);
    });

    it('refuses a key that is not declared for the kind, a missing required key, and a wrong type or enum value', async () => {
      expect(await closed('merged', { pr: 1, closes: true, extra: 1 })).toBe(false);
      expect(await closed('merged', { pr: 1 })).toBe(false);
      expect(await closed('merged', { pr: '1', closes: true })).toBe(false);
      expect(await closed('merged', { pr: 0, closes: true })).toBe(false);
      expect(await closed('merged', { pr: 1.5, closes: true })).toBe(false);
      expect(await closed('merge_lane', { pr: 1, state: 'merged!' })).toBe(false);
      expect(await closed('gate_receipt', { pr: 1, gate: 'gate1', result: 'pass', head_sha: 'a'.repeat(39) })).toBe(false);
      expect(await closed('agent_started', { spawn_id: 'tool_1', role: 'executor', background: true, isolation: 'none' })).toBe(false);
      expect(await closed('agent_started', { spawn_id: 'toolu_1', role: 'executor', background: 'yes', isolation: 'none' })).toBe(false);
      expect(await closed('team_log_line', { line_id: '0123456789abcdef', actor_role: 'a person', category: 'merged' })).toBe(false);
      expect(await closed('merged', [1])).toBe(false);
    });

    it('refuses free-text and money-named keys at any depth, with the error naming neither a key nor a value', async () => {
      for (const key of ['text', 'message', 'content', 'output', 'prompt', 'description', 'title', 'body', 'branch', 'path', 'usd', 'cost', 'cost_usd', 'price', 'total_tokens', 'TOTAL_USD', 'api_equivalent_usd', 'cost_basis', 'price_table']) {
        expect(await closed('merged', { pr: 1, closes: true, [key]: 1 }), key).toBe(false);
        expect(await closed('engine_heartbeat', { origin: 'cron', source_ages_s: { [key]: 1 } }), `nested ${key}`).toBe(false);
        expect(await closed('plan_snapshot', { ...(VALID.plan_snapshot as object), items: [{ discussion: 1, ordinal: 0, state: 'planned', [key]: 1 }] }), `row ${key}`).toBe(false);
      }
      await expect(admin.query(`INSERT INTO engine_events (session_id, seq, account_id, ts, kind, body) VALUES ($1, 90, $2, now(), 'merged', '{"pr":1,"closes":true,"message":"SECRET-VALUE"}')`, [ids.a.session, a.accountId])).rejects.toSatisfy(
        (e: unknown) => /engine_events_body_closed/.test((e as Error).message) && !(e as Error).message.includes('SECRET-VALUE'),
      );
    });

    it('lets usage carry its `output` token count and nowhere else', async () => {
      expect(await closed('agent_stopped', { ...(VALID.agent_stopped as object), usage: { output: 5 } })).toBe(true);
      expect(await closed('agent_stopped', { ...(VALID.agent_stopped as object), usage: { output: 5, usd: 1 } })).toBe(false);
      expect(await closed('agent_stopped', { ...(VALID.agent_stopped as object), usage: {} })).toBe(false);
      expect(await closed('agent_stopped', { ...(VALID.agent_stopped as object), usage: { input: -1 } })).toBe(false);
      expect(await closed('agent_stopped', { ...(VALID.agent_stopped as object), usage: { input: 1e13 } })).toBe(false);
      expect(await closed('agent_stopped', { ...(VALID.agent_stopped as object), usage: { input: 'x' } })).toBe(false);
      expect(await closed('merged', { pr: 1, closes: true, output: 5 })).toBe(false);
    });

    it('holds a plan snapshot to its chunk rules, the real row-key pattern and the real status set', async () => {
      const snap = VALID.plan_snapshot as Record<string, unknown>;
      expect(await closed('plan_snapshot', { ...snap, chunk_index: 2 })).toBe(false);
      expect(await closed('plan_snapshot', { ...snap, chunk_count: 101, chunk_index: 0 })).toBe(false);
      expect(await closed('plan_snapshot', { ...snap, roadmap: [{ row_key: 'has space', status: 'done' }] })).toBe(false);
      expect(await closed('plan_snapshot', { ...snap, roadmap: [{ row_key: 'a'.repeat(49), status: 'done' }] })).toBe(false);
      expect(await closed('plan_snapshot', { ...snap, roadmap: [{ row_key: 'K', status: 'planned' }] })).toBe(false);
      for (const status of ['not_started', 'in_progress', 'done', 'blocked', 'deferred', 'split', 'removed', 'superseded']) {
        expect(await closed('plan_snapshot', { ...snap, roadmap: [{ row_key: 'K-1.a', status }] }), status).toBe(true);
      }
      const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ row_key: `R${i}`, status: 'done' }));
      expect(await closed('plan_snapshot', { ...snap, items: [], roadmap: rows(500) })).toBe(true);
      expect(await closed('plan_snapshot', { ...snap, items: [], roadmap: rows(501) })).toBe(false);
    });

    it('caps plan items at 300 and roadmap rows at 500 as two separate caps, as the runner-protocol schema does', async () => {
      const snap = VALID.plan_snapshot as Record<string, unknown>;
      const items = (n: number) => Array.from({ length: n }, (_, i) => ({ discussion: 1 + i, ordinal: i, state: 'planned' }));
      const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ row_key: `R${i}`, status: 'done' }));
      expect(await closed('plan_snapshot', { ...snap, items: items(300), roadmap: rows(500) })).toBe(true);
      expect(await closed('plan_snapshot', { ...snap, items: items(301), roadmap: [] })).toBe(false);
      expect(await closed('plan_snapshot', { ...snap, items: items(0), roadmap: rows(501) })).toBe(false);
    });

    it('allows an empty row_key (a bare D#N row has one), and refuses a malformed one', async () => {
      const snap = VALID.plan_snapshot as Record<string, unknown>;
      expect(await closed('plan_snapshot', { ...snap, roadmap: [{ row_key: '', discussion: 842, status: 'in_progress', planned_prs: 2 }] })).toBe(true);
      expect(await closed('plan_snapshot', { ...snap, roadmap: [{ row_key: '', status: 'done' }] })).toBe(true);
      expect(await closed('plan_snapshot', { ...snap, roadmap: [{ status: 'done' }] })).toBe(false);
      expect(await closed('plan_snapshot', { ...snap, roadmap: [{ row_key: '.x', status: 'done' }] })).toBe(false);
    });

    it('a full chunk of maximum-size rows, as large as the runner-protocol schema lets a chunk be (64 KiB compact), passes', async () => {
      expect(await closed('engine_heartbeat', { origin: 'cron', source_ages_s: {} })).toBe(true);
      const snap = VALID.plan_snapshot as Record<string, unknown>;
      // Maximum-size values: a 48-character row_key, 10-digit numbers, the longest state and status words.
      const item = (i: number) => ({ discussion: 2_147_483_647, ordinal: 2_147_483_647 - i, state: 'in_progress' });
      const row = (i: number) => ({ row_key: `K${String(i).padStart(3, '0')}${'x'.repeat(44)}`, discussion: 2_147_483_647, status: 'not_started', planned_prs: 2_147_483_647 });
      expect(row(0).row_key).toHaveLength(48);
      const body = { ...snap, items: Array.from({ length: 300 }, (_, i) => item(i)), roadmap: [] as object[] };
      const compact = (b: object) => Buffer.byteLength(JSON.stringify(b));
      while (body.roadmap.length < 500 && compact({ ...body, roadmap: [...body.roadmap, row(body.roadmap.length)] }) <= 65_536) body.roadmap.push(row(body.roadmap.length));
      expect(compact(body)).toBeLessThanOrEqual(65_536);
      expect(compact(body)).toBeGreaterThan(65_000);
      expect(body.roadmap.length).toBeGreaterThan(300);
      expect(await closed('plan_snapshot', body)).toBe(true);
      // 500 maximum-length keys on their own (the most rows a chunk may hold) are also under the cap with the shortest status.
      const wide = Array.from({ length: 500 }, (_, i) => ({ ...row(i), status: 'done' }));
      expect(compact({ ...snap, items: [], roadmap: wide })).toBeLessThanOrEqual(65_536);
      expect(await closed('plan_snapshot', { ...snap, items: [], roadmap: wide })).toBe(true);
    });

    it('refuses a deeply nested body with false, not an error (the declared keys are checked before the recursive scan)', async () => {
      const deep = (n: number): unknown => (n === 0 ? 1 : { x: deep(n - 1) });
      expect(await closed('merged', { pr: 1, closes: true, x: deep(2000) })).toBe(false);
      expect(await closed('engine_heartbeat', { origin: 'cron', source_ages_s: deep(2000) })).toBe(false);
    });
  });

  describe('row security', () => {
    it('a member of account A reads 0 rows of account B from every new table, and 1 of its own', async () => {
      for (const t of ENGINE_TABLES) {
        const { rows } = await withTenant(appPool, a.accountId, a.userId, (c) => c.query(`SELECT account_id FROM ${t}`));
        expect(rows.map((r) => r.account_id), t).toEqual([a.accountId]);
        expect((await withTenant(appPool, b.accountId, b.userId, (c) => c.query(`SELECT account_id FROM ${t}`))).rows.map((r) => r.account_id), t).toEqual([b.accountId]);
      }
    });

    it('with no tenant set, every new table reads empty', async () => {
      for (const t of ENGINE_TABLES) expect((await appPool.query(`SELECT 1 FROM ${t}`)).rowCount, t).toBe(0);
    });

    it('app_user can write none of the event tables, and cannot call the ingest as a member', async () => {
      const inserts: Array<[string, string, unknown[]]> = [
        ['engine_sessions', `INSERT INTO engine_sessions (account_id, runner_id, repo_id, engine_instance_id, engine_version) VALUES ($1, $2, $3, $4, '1.0.0')`, [a.accountId, ids.a.runner, a.repoId, randomUUID()]],
        ['engine_events', `INSERT INTO engine_events (session_id, seq, account_id, ts, kind) VALUES ($2, 77, $1, now(), 'compaction_detected')`, [a.accountId, ids.a.session]],
        ['engine_agent_usage', `INSERT INTO engine_agent_usage (account_id, session_id, subject_kind, subject_id, credential_mode) VALUES ($1, $2, 'agent', 'x', 'subscription')`, [a.accountId, ids.a.session]],
      ];
      for (const [t, sql, params] of inserts) {
        await expect(withTenant(appPool, a.accountId, a.userId, (c) => c.query(sql, params)), t).rejects.toMatchObject({ code: '42501' });
      }
      await expect(withTenant(appPool, a.accountId, a.userId, (c) => c.query(`UPDATE engine_sessions SET last_seq = 99`))).rejects.toMatchObject({ code: '42501' });
      await expect(withTenant(appPool, a.accountId, a.userId, (c) => c.query(`DELETE FROM engine_events`))).rejects.toMatchObject({ code: '42501' });
      await expect(
        withTenant(appPool, a.accountId, a.userId, (c) =>
          c.query(`SELECT * FROM engine_events_ingest($1::uuid, $2::uuid, 1::bigint, $3::uuid, '1.0.0', '[{"seq":0,"ts":"2026-11-16T10:00:00Z","kind":"compaction_detected","body":{}}]'::jsonb)`, [a.accountId, ids.a.runner, randomUUID()]),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it("a session cannot point a row at another account's session, runner or repo (composite keys)", async () => {
      await expect(admin.query(`INSERT INTO engine_lanes (account_id, session_id, pr, state, updated_at) VALUES ($1, $2, 9, 'queued', now())`, [a.accountId, ids.b.session])).rejects.toMatchObject({ code: '23503' });
      await expect(admin.query(`INSERT INTO engine_sessions (account_id, runner_id, repo_id, engine_instance_id, engine_version) VALUES ($1, $2, $3, $4, '1.0.0')`, [a.accountId, ids.b.runner, a.repoId, randomUUID()])).rejects.toMatchObject({ code: '23503' });
      await expect(admin.query(`INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)`, [a.accountId, b.repoId])).rejects.toMatchObject({ code: '23503' });
    });
  });

  describe('the switches', () => {
    let memberId: string;
    let tokenId: string;
    beforeAll(async () => {
      memberId = randomUUID();
      await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [memberId, `${memberId}@example.test`]);
      await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [a.accountId, memberId]);
      tokenId = randomUUID();
    });

    it('an owner on a session may change them; a member and a token principal may not', async () => {
      const set = (userId: string, token?: string) =>
        withTenant(appPool, a.accountId, userId, token, (c) => c.query(`UPDATE engine_bridge_settings SET watch_enabled = true, updated_by = $1 WHERE account_id = $2`, [userId, a.accountId]));
      expect((await set(a.userId)).rowCount).toBe(1);
      expect((await set(memberId)).rowCount).toBe(0);
      expect((await set(a.userId, tokenId)).rowCount).toBe(0);
      const tick = (userId: string, token?: string) =>
        withTenant(appPool, a.accountId, userId, token, (c) => c.query(`DELETE FROM engine_bridge_repos WHERE repo_id = $1`, [a.repoId]));
      expect((await tick(memberId)).rowCount).toBe(0);
      expect((await tick(a.userId, tokenId)).rowCount).toBe(0);
      expect((await tick(a.userId)).rowCount).toBe(1);
      await withTenant(appPool, a.accountId, a.userId, (c) => c.query(`INSERT INTO engine_bridge_repos (account_id, repo_id, enabled_by) VALUES ($1, $2, $3)`, [a.accountId, a.repoId, a.userId]));
      await expect(withTenant(appPool, a.accountId, memberId, (c) => c.query(`INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)`, [a.accountId, a.repoId]))).rejects.toMatchObject({ code: '42501' });
    });

    it('cannot write for another account, and operate cannot be on while watch is off', async () => {
      await expect(withTenant(appPool, a.accountId, a.userId, (c) => c.query(`INSERT INTO engine_bridge_settings (account_id) VALUES ($1)`, [b.accountId]))).rejects.toMatchObject({ code: '42501' });
      await expect(admin.query(`UPDATE engine_bridge_settings SET watch_enabled = false, operate_enabled = true WHERE account_id = $1`, [a.accountId])).rejects.toMatchObject({ code: '23514' });
    });
  });

  describe('retention and delete', () => {
    it('the prune removes events received over 30 days ago, a batch at a time, and nothing newer', async () => {
      const s = ids.a.session;
      for (const [seq, age] of [[200, '31 days'], [201, '40 days'], [202, '29 days']] as const) {
        await admin.query(`INSERT INTO engine_events (session_id, seq, account_id, ts, kind, received_at) VALUES ($1, $2, $3, now(), 'compaction_detected', now() - $4::interval)`, [s, seq, a.accountId, age]);
      }
      const prune = async (n: number) => (await opsPool.query('SELECT engine_events_prune($1::int) AS n', [n])).rows[0].n as number;
      expect(await prune(1)).toBe(1);
      expect(await prune(100)).toBe(1);
      expect(await prune(100)).toBe(0);
      const left = (await admin.query(`SELECT seq FROM engine_events WHERE session_id = $1 AND seq >= 200`, [s])).rows.map((r) => Number(r.seq));
      expect(left).toEqual([202]);
      await expect(opsPool.query('SELECT engine_events_prune(0)')).rejects.toMatchObject({ code: '22023' });
      await expect(appPool.query('SELECT engine_events_prune(10)')).rejects.toMatchObject({ code: '42501' });
    });

    it("the owner's delete removes every session of the account and the read model with it, leaves the other account alone, and a member cannot call it", async () => {
      const memberId = randomUUID();
      await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [memberId, `${memberId}@example.test`]);
      await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [b.accountId, memberId]);
      await expect(withTenant(appPool, b.accountId, memberId, (c) => c.query('SELECT engine_data_delete()'))).rejects.toMatchObject({ code: '42501' });
      await expect(withTenant(appPool, b.accountId, b.userId, randomUUID(), (c) => c.query('SELECT engine_data_delete()'))).rejects.toMatchObject({ code: '42501' });
      const n = (await withTenant(appPool, b.accountId, b.userId, (c) => c.query('SELECT engine_data_delete() AS n'))).rows[0].n;
      expect(n).toBe(1);
      for (const t of ['engine_sessions', 'engine_events', 'engine_agents', 'engine_lanes', 'engine_gate_receipts', 'engine_asks', 'engine_session_gaps', 'engine_agent_usage'] as const) {
        expect(Number((await admin.query(`SELECT count(*) AS n FROM ${t} WHERE account_id = $1`, [b.accountId])).rows[0].n), t).toBe(0);
        expect(Number((await admin.query(`SELECT count(*) AS n FROM ${t} WHERE account_id = $1`, [a.accountId])).rows[0].n), `${t} (other account)`).toBeGreaterThan(0);
      }
      expect(Number((await admin.query(`SELECT count(*) AS n FROM engine_bridge_settings WHERE account_id = $1`, [b.accountId])).rows[0].n)).toBe(1);
    });
  });
  describe('settings and delete helpers (with their audit rows)', () => {
    const audit = async (accountId: string, action: string) =>
      (await admin.query(`SELECT payload FROM audit_log WHERE account_id = $1 AND action = $2 ORDER BY created_at, id`, [accountId, action])).rows.map((r) => r.payload);

    it('changes the switches and repos for an owner, one audit row per changed facet and none for an unchanged one', async () => {
      const c = await admin.query(`INSERT INTO account_members (account_id, user_id, role) SELECT $1, $2, 'owner' WHERE false`, [a.accountId, a.userId]);
      expect(c.rowCount).toBe(0);
      await admin.query(`DELETE FROM engine_bridge_settings WHERE account_id = $1`, [a.accountId]);
      await admin.query(`DELETE FROM engine_bridge_repos WHERE account_id = $1`, [a.accountId]);
      const run = (patch: Parameters<typeof setEngineBridgeSettings>[2]) => withTenant(appPool, a.accountId, a.userId, (cl) => setEngineBridgeSettings(cl, a.userId, patch));
      expect(await withTenant(appPool, a.accountId, a.userId, (cl) => readEngineBridgeSettings(cl))).toEqual({ watch_enabled: false, operate_enabled: false, repo_ids: [] });
      expect(await run({ watch_enabled: true, repo_ids: [a.repoId] })).toEqual({ watch_enabled: true, operate_enabled: false, repo_ids: [a.repoId] });
      expect(await run({ watch_enabled: true, repo_ids: [a.repoId] })).toEqual({ watch_enabled: true, operate_enabled: false, repo_ids: [a.repoId] });
      expect(await run({ operate_enabled: true })).toMatchObject({ operate_enabled: true });
      await expect(run({ watch_enabled: false })).rejects.toMatchObject({ code: '23514' });
      expect(await run({ watch_enabled: false, operate_enabled: false, repo_ids: [] })).toEqual({ watch_enabled: false, operate_enabled: false, repo_ids: [] });
      expect(await audit(a.accountId, 'engine_bridge.settings_changed')).toEqual([
        { kind: 'watch_on' },
        { kind: 'repo_added', repo_id: a.repoId },
        { kind: 'operate_on' },
        { kind: 'watch_off' },
        { kind: 'operate_off' },
        { kind: 'repo_removed', repo_id: a.repoId },
      ]);
      await run({ watch_enabled: true, repo_ids: [a.repoId] });
    });

    it('a member cannot change them, and nothing is written or audited', async () => {
      const memberId = randomUUID();
      await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [memberId, `${memberId}@example.test`]);
      await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [a.accountId, memberId]);
      const before = (await audit(a.accountId, 'engine_bridge.settings_changed')).length;
      await expect(withTenant(appPool, a.accountId, memberId, (cl) => setEngineBridgeSettings(cl, memberId, { watch_enabled: false }))).rejects.toMatchObject({ code: '42501' });
      expect((await audit(a.accountId, 'engine_bridge.settings_changed')).length).toBe(before);
    });

    it('deleting engine data audits it in the same transaction, and a failed audit write undoes the delete', async () => {
      const count = async () => Number((await admin.query(`SELECT count(*) AS n FROM engine_sessions WHERE account_id = $1`, [a.accountId])).rows[0].n);
      expect(await count()).toBe(1);
      await expect(
        withTenant(appPool, a.accountId, a.userId, async (cl) => {
          await deleteEngineData(cl);
          throw new Error('later step failed');
        }),
      ).rejects.toThrow('later step failed');
      expect(await count()).toBe(1);
      expect(await audit(a.accountId, 'engine_bridge.data_deleted')).toEqual([]);
      expect(await withTenant(appPool, a.accountId, a.userId, (cl) => deleteEngineData(cl))).toBe(1);
      expect(await count()).toBe(0);
      expect(await audit(a.accountId, 'engine_bridge.data_deleted')).toEqual([{}]);
    });
  });
  describe('settings view', () => {
    it('lists every repo of the account by name with ticked and eligible flags, and only its own', async () => {
      await admin.query(`UPDATE repos SET gh_owner = 'acme', gh_name = 'app', execution_mode = 'runner_local' WHERE id = $1`, [a.repoId]);
      const v = await withTenant(appPool, a.accountId, a.userId, (c) => readEngineSettingsView(c, true));
      expect(v).toMatchObject({ can_edit: true, repos: [{ repo_id: a.repoId, full_name: 'acme/app', eligible: true, refusal: null }] });
      expect(v.repos).toHaveLength(1);
      await admin.query(`UPDATE repos SET gh_owner = NULL, gh_name = NULL, execution_mode = 'sandbox' WHERE id = $1`, [a.repoId]);
      const w = await withTenant(appPool, a.accountId, a.userId, (c) => readEngineSettingsView(c, false));
      expect(w.repos[0]).toMatchObject({ full_name: `Unnamed repository (${a.repoId.slice(0, 8)})`, eligible: false, refusal: 'repo_not_runner_local' });
      expect(w.can_edit).toBe(false);
      await admin.query(`UPDATE repos SET execution_mode = 'runner_local' WHERE id = $1`, [a.repoId]);
    });

    it('bridged_runner_id: the runner of the repo\'s newest session, null for a second repo of the same account, and nothing of another account', async () => {
      const second = randomUUID();
      await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name, execution_mode) VALUES ($1, $2, $3, 'team', 'acme', 'second', 'runner_local')`, [second, a.accountId, Math.floor(Math.random() * 1e9)]);
      await admin.query(`DELETE FROM engine_sessions WHERE repo_id = ANY ($1::uuid[])`, [[a.repoId, second, b.repoId]]);
      const view = () => withTenant(appPool, a.accountId, a.userId, (c) => readEngineSettingsView(c, true));
      const bridged = async () => Object.fromEntries((await view()).repos.map((r) => [r.repo_id, r.bridged_runner_id]));
      expect(await bridged()).toEqual({ [a.repoId]: null, [second]: null });
      await admin.query(`INSERT INTO engine_sessions (account_id, runner_id, repo_id, engine_instance_id, engine_version, session_kind) VALUES ($1, $2, $3, $4, '1.2.3', 'bridge')`, [a.accountId, ids.a.runner, a.repoId, randomUUID()]);
      expect(await bridged()).toEqual({ [a.repoId]: ids.a.runner, [second]: null }); // the second repo of the same account stays empty
      // A newer session from another runner of the same account moves the repo to that runner.
      const later = await insertRunner(admin, a.accountId, a.userId);
      await admin.query(`INSERT INTO engine_sessions (account_id, runner_id, repo_id, engine_instance_id, engine_version, session_kind, created_at) VALUES ($1, $2, $3, $4, '1.2.3', 'bridge', now() + interval '1 minute')`, [a.accountId, later, a.repoId, randomUUID()]);
      expect(await bridged()).toEqual({ [a.repoId]: later, [second]: null });
      await admin.query(`DELETE FROM engine_sessions WHERE runner_id = $1`, [later]);
      // Another account's session for its own repo never shows here, and the RLS-bypassing admin client with no account named reads no repo at all.
      await admin.query(`INSERT INTO engine_sessions (account_id, runner_id, repo_id, engine_instance_id, engine_version, session_kind) VALUES ($1, $2, $3, $4, '1.2.3', 'bridge')`, [b.accountId, ids.b.runner, b.repoId, randomUUID()]);
      expect(Object.keys(await bridged())).not.toContain(b.repoId);
      expect((await readEngineSettingsView(admin, true)).repos).toEqual([]);
      const asB = await withTenant(appPool, b.accountId, b.userId, (c) => readEngineSettingsView(c, true));
      expect(asB.repos.find((r) => r.repo_id === b.repoId)?.bridged_runner_id).toBe(ids.b.runner);
      expect(asB.repos.map((r) => r.bridged_runner_id)).not.toContain(ids.a.runner);
      await admin.query(`DELETE FROM engine_sessions WHERE repo_id = ANY ($1::uuid[])`, [[a.repoId, second, b.repoId]]);
      await admin.query(`DELETE FROM repos WHERE id = $1`, [second]);
    });
  });

  describe('freshness read', () => {
    // The owner's delete above removed account a's session, so these tests make their own.
    const mk = async (kind: 'engine' | 'bridge', createdAgo: string, o: { event?: string; beat?: string; heard?: string; ages?: object; firstEvent?: string } = {}) => {
      const id = randomUUID();
      await admin.query(`INSERT INTO engine_sessions (id, account_id, runner_id, repo_id, engine_instance_id, engine_version, session_kind, created_at) VALUES ($1, $2, $3, $4, $5, '1.2.3', $6, now() - $7::interval)`, [id, a.accountId, ids.a.runner, a.repoId, randomUUID(), kind, createdAgo]);
      await admin.query(
        `UPDATE engine_sessions SET last_event_at = $2::timestamptz, last_heartbeat_at = $3::timestamptz, last_heard_at = now() - $4::interval, source_ages_s = $5::jsonb, first_event_at = $6::timestamptz WHERE id = $1`,
        [id, o.event ?? null, o.beat ?? null, o.heard ?? null, o.ages ? JSON.stringify(o.ages) : null, o.firstEvent ?? null],
      );
      return id;
    };
    const fresh = () => withTenant(appPool, a.accountId, a.userId, (c) => readEngineRepoFreshness(c, a.repoId));
    beforeAll(async () => {
      await admin.query(`DELETE FROM engine_sessions WHERE repo_id = $1`, [a.repoId]);
    });

    it('answers nothing for a repo with no session, and nothing for another account', async () => {
      expect(await fresh()).toBeNull();
    });

    it('merges the engine and bridge sessions: as_of is the newest event or heartbeat of all, heard age the smallest, and the gaps and missing events add up', async () => {
      // Engine session: last event 10:00:00, last heartbeat 10:20:00 (the later one counts), heard 400 s ago.
      const eng = await mk('engine', '3 hours', { event: '2026-11-16T10:00:00Z', beat: '2026-11-16T10:20:00Z', heard: '400 seconds', ages: { loop: 7 } });
      // Bridge session (newer by the server's clock): its last event 10:45:00 beats the engine's, its heartbeat is older, heard 90 s ago.
      const br = await mk('bridge', '1 hour', { event: '2026-11-16T10:45:00Z', beat: '2026-11-16T10:05:00Z', heard: '90 seconds' });
      // An older engine session (a restart), heard long ago, with a source age of its own that must not win.
      const old = await mk('engine', '9 hours', { event: '2026-11-16T09:00:00Z', heard: '5 hours', ages: { loop: 1 } });
      await admin.query(`INSERT INTO engine_session_gaps (account_id, session_id, from_seq, to_seq, detected_at) VALUES ($1, $2, 1, 2, '2026-11-16T10:00:00Z'), ($1, $2, 10, 14, '2026-11-16T10:30:00Z'), ($1, $3, 5, 5, '2026-11-16T10:40:00Z'), ($1, $4, 20, 29, '2026-11-16T09:30:00Z')`, [a.accountId, eng, br, old]);
      const f = (await fresh())!;
      expect(f.as_of).toBe('2026-11-16T10:45:00.000Z');
      expect(f.heard_age_s).toBe(90);
      expect(f.missing_events).toBe(2 + 5 + 1 + 10);
      expect(f.gaps.map((g) => [g.from_seq, g.to_seq])).toEqual([[5, 5], [10, 14], [1, 2], [20, 29]]);
      // The engine's newest session (by the server's clock) speaks for the sources, not the bridge (it has none) nor the old restart.
      expect(f.source_ages_s).toEqual({ loop: 7 });
      expect(f.session_id).toBe(eng);
      expect(f.session_kind).toBe('engine');
      expect(await withTenant(appPool, b.accountId, b.userId, (c) => readEngineRepoFreshness(c, a.repoId))).toBeNull();
    });

    it('as_of is the later of event and heartbeat within a session, and a bridge-only repo is answered from its bridge session', async () => {
      await admin.query(`DELETE FROM engine_sessions WHERE repo_id = $1`, [a.repoId]);
      const br = await mk('bridge', '1 hour', { event: '2026-11-16T10:00:00Z', beat: '2026-11-16T10:30:00Z', heard: '30 seconds' });
      const f = (await fresh())!;
      expect(f).toMatchObject({ as_of: '2026-11-16T10:30:00.000Z', heard_age_s: 30, session_id: br, session_kind: 'bridge', source_ages_s: {}, missing_events: 0, gaps: [] });
      await admin.query(`UPDATE engine_sessions SET last_event_at = '2026-11-16T10:50:00Z' WHERE id = $1`, [br]);
      expect((await fresh())!.as_of).toBe('2026-11-16T10:50:00.000Z');
    });

    it("a host-spool session (an engine-kind session with no source ages) heard more recently never hides the engine's source ages", async () => {
      await admin.query(`DELETE FROM engine_sessions WHERE repo_id = $1`, [a.repoId]);
      const eng = await mk('engine', '3 hours', { event: '2026-11-16T10:00:00Z', heard: '60 seconds', ages: { loop: 10800 } });
      await mk('engine', '2 hours', { event: '2026-11-16T10:30:00Z', beat: '2026-11-16T10:30:00Z', heard: '10 seconds' });
      const f = (await fresh())!;
      expect(f.source_ages_s).toEqual({ loop: 10800 });
      // Heard age is still the newest of all sessions.
      expect(f.heard_age_s).toBe(10);
      expect(eng).toBeTruthy();
    });

    it('orders sessions by the server clock: a session whose client-sent first event is far in the future does not stay the newest', async () => {
      await admin.query(`DELETE FROM engine_sessions WHERE repo_id = $1`, [a.repoId]);
      const future = await mk('engine', '5 hours', { event: '2026-11-16T10:00:00Z', heard: '5 hours', ages: { loop: 99 }, firstEvent: '2099-01-01T00:00:00Z' });
      const real = await mk('engine', '1 hour', { event: '2026-11-16T10:00:00Z', heard: '10 seconds', ages: { loop: 3 } });
      const f = (await fresh())!;
      expect(f.session_id).toBe(real);
      expect(f.session_id).not.toBe(future);
      expect(f.source_ages_s).toEqual({ loop: 3 });
    });
  });

  describe('the account policy, the prune gate and the repo quota table', () => {
    it("the definer sees only the caller's own membership row, as 0757 and 0770 do", async () => {
      const pol = (await admin.query(`SELECT qual FROM pg_policies WHERE tablename = 'account_members' AND policyname = 'engine_bridge_definer_select'`)).rows[0].qual as string;
      expect(pol).toContain('app.user_id');
      expect(pol).toContain('user_id');
    });

    it('the prune sees nothing while a tenant is set on the session, and everything old when none is', async () => {
      const s = (await admin.query(`SELECT id FROM engine_sessions WHERE account_id = $1 LIMIT 1`, [a.accountId])).rows[0]?.id ?? (await (async () => {
        const id = randomUUID();
        await admin.query(`INSERT INTO engine_sessions (id, account_id, runner_id, repo_id, engine_instance_id, engine_version) VALUES ($1, $2, $3, $4, $5, '1.2.3')`, [id, a.accountId, ids.a.runner, a.repoId, randomUUID()]);
        return id;
      })());
      await admin.query(`INSERT INTO engine_events (session_id, seq, account_id, ts, kind, received_at) VALUES ($1, 900, $2, now(), 'compaction_detected', now() - interval '45 days')`, [s, a.accountId]);
      const c = await opsPool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.account_id', $1, true)`, [a.accountId]);
        expect((await c.query('SELECT engine_events_prune(100) AS n')).rows[0].n).toBe(0);
        await c.query('ROLLBACK');
      } finally {
        c.release();
      }
      expect(Number((await admin.query(`SELECT count(*) AS n FROM engine_events WHERE session_id = $1 AND seq = 900`, [s])).rows[0].n)).toBe(1);
      expect((await opsPool.query('SELECT engine_events_prune(100) AS n')).rows[0].n).toBeGreaterThanOrEqual(1);
      expect(Number((await admin.query(`SELECT count(*) AS n FROM engine_events WHERE session_id = $1 AND seq = 900`, [s])).rows[0].n)).toBe(0);
    });

    it('the repo quota table has row security: an account reads its own row only, writes none, and an owner delete of engine data leaves it', async () => {
      await admin.query(`INSERT INTO engine_repo_quota (account_id, repo_id, quota_day, quota_count) VALUES ($1, $2, current_date, 7), ($3, $4, current_date, 9) ON CONFLICT (account_id, repo_id) DO UPDATE SET quota_count = EXCLUDED.quota_count`, [a.accountId, a.repoId, b.accountId, b.repoId]);
      const mine = await withTenant(appPool, a.accountId, a.userId, (c) => c.query(`SELECT account_id, quota_count FROM engine_repo_quota`));
      expect(mine.rows.map((r) => [r.account_id, r.quota_count])).toEqual([[a.accountId, 7]]);
      expect((await appPool.query(`SELECT 1 FROM engine_repo_quota`)).rowCount).toBe(0);
      await expect(withTenant(appPool, a.accountId, a.userId, (c) => c.query(`UPDATE engine_repo_quota SET quota_count = 0`))).rejects.toMatchObject({ code: '42501' });
      await withTenant(appPool, a.accountId, a.userId, (c) => c.query('SELECT engine_data_delete()'));
      expect(Number((await admin.query(`SELECT quota_count FROM engine_repo_quota WHERE account_id = $1`, [a.accountId])).rows[0].quota_count)).toBe(7);
    });

    it('engine_usage_price refuses a runner of an account that is not active, and prices for an active one', async () => {
      const sess = randomUUID();
      await admin.query(`INSERT INTO engine_sessions (id, account_id, runner_id, repo_id, engine_instance_id, engine_version) VALUES ($1, $2, $3, $4, $5, '1.2.3')`, [sess, a.accountId, ids.a.runner, a.repoId, randomUUID()]);
      await admin.query(`INSERT INTO engine_agent_usage (account_id, session_id, subject_kind, subject_id, credential_mode) VALUES ($1, $2, 'agent', 'price-me', 'subscription')`, [a.accountId, sess]);
      const price = () =>
        withTenant(appPool, a.accountId, async (c) => {
          await c.query(`SELECT set_config('app.runner_id', $1, true)`, [ids.a.runner]);
          await c.query(`SELECT engine_usage_price($1::uuid, $2::uuid, 'agent', 'price-me', 1.5, 'v1')`, [a.accountId, sess]);
        });
      await price();
      expect((await admin.query(`SELECT api_equivalent_usd::text AS usd FROM engine_agent_usage WHERE subject_id = 'price-me'`)).rows[0].usd).toBe('1.5000');
      await admin.query(`UPDATE accounts SET deleted_at = now() WHERE id = $1`, [a.accountId]);
      try {
        await expect(price()).rejects.toMatchObject({ code: '42501' });
      } finally {
        await admin.query(`UPDATE accounts SET deleted_at = NULL WHERE id = $1`, [a.accountId]);
      }
    });
  });

  describe('the runner capability', () => {
    it("a hello that declares engine_bridge_v1 stores, and an unknown code is still refused", async () => {
      const record = (caps: string[]) =>
        withTenant(appPool, a.accountId, async (c) => {
          await c.query(`SELECT set_config('app.runner_id', $1, true)`, [ids.a.runner]);
          await c.query('SELECT runner_capabilities_record($1::text[])', [caps]);
        });
      await record(['wake_v1', 'engine_bridge_v1']);
      expect((await admin.query(`SELECT capabilities FROM runner_capabilities WHERE runner_id = $1`, [ids.a.runner])).rows[0].capabilities).toEqual(['wake_v1', 'engine_bridge_v1']);
      await expect(record(['engine_bridge_v2'])).rejects.toMatchObject({ code: '22023' });
      await expect(admin.query(`UPDATE runner_capabilities SET capabilities = ARRAY['nope'] WHERE runner_id = $1`, [ids.a.runner])).rejects.toMatchObject({ code: '23514' });
    });
  });
});
