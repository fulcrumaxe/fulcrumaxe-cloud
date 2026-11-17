import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { agentStateOf, livenessOf } from '@fx/core/src/engine/panels.js';
import { WEBHOOK_EVENT_TYPES } from '@fx/webhooks';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { handleEventsRequest } from '../src/sse/stream.js';
import { AccountPoller } from '../src/sse/poller.js';
import { eventually, openSse, startServer } from './helpers/sse.js';
import { engineRoutes as engineReadRoutes, engineSettingsDeps } from '../src/routes/engine.js';
import { seedAccountWithMember, seedUser } from './helpers/seed.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any; // a decoded response body: its shape is what each test asserts

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID_LIKE = /^[A-Za-z0-9_.:-]{1,64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const NAME = /^([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+|Unnamed (runner|repository) \([0-9a-f]{8}\))$/;

/**
 * Keys the walker does not read. `row_key` is a roadmap row key; `runner_name` is the runner's stored name or its registrant's name, typed by a person of the
 * account and checked by `runner_name_valid` (its own test below), never text the engine wrote.
 */
const EXEMPT_KEYS = new Set(['row_key', 'runner_name']);

/** Every string in a response must be an id, an enum word, a uuid, an ISO date or a cloud-side name: nothing a person or the engine could have typed. */
function freeText(v: unknown, at = '$'): string[] {
  if (typeof v === 'string') return UUID.test(v) || ISO.test(v) || ID_LIKE.test(v) || NAME.test(v) ? [] : [`${at}=${JSON.stringify(v)}`];
  if (Array.isArray(v)) return v.flatMap((x, i) => freeText(x, `${at}[${i}]`));
  if (v !== null && typeof v === 'object') return Object.entries(v).flatMap(([k, x]) => (EXEMPT_KEYS.has(k) ? [] : freeText(x, `${at}.${k}`)));
  return [];
}

describe('engine panel state rules (pure)', () => {
  it('agent state: every stop x live session x start age combination', () => {
    for (const stopped of [true, false]) {
      for (const sessionLive of [true, false]) {
        for (const startAgeS of [60, 3 * 3600 - 1, 3 * 3600, 4 * 3600]) {
          const want = stopped ? 'stopped' : sessionLive && startAgeS < 3 * 3600 ? 'running' : 'unknown';
          expect(agentStateOf({ stopped, sessionLive, startAgeS }), `${stopped} ${sessionLive} ${startAgeS}`).toBe(want);
        }
      }
    }
    expect(agentStateOf({ stopped: false, sessionLive: true, startAgeS: null })).toBe('unknown');
  });
  it('liveness: live within 180 s, stale after, removed and never win', () => {
    expect(livenessOf({ sessionCount: 0, revoked: true, heardAgeS: null })).toBe('never');
    expect(livenessOf({ sessionCount: 1, revoked: true, heardAgeS: 5 })).toBe('runner_removed');
    expect(livenessOf({ sessionCount: 1, revoked: false, heardAgeS: 180 })).toBe('live');
    expect(livenessOf({ sessionCount: 1, revoked: false, heardAgeS: 181 })).toBe('stale');
    expect(livenessOf({ sessionCount: 1, revoked: false, heardAgeS: null })).toBe('stale');
  });
  it('engine.changed is a stream-only event, never an outbound webhook type', () => {
    expect(WEBHOOK_EVENT_TYPES as readonly string[]).not.toContain('engine.changed');
  });
});

describe('engine read routes and settings [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let A: SeedRefs;
  let member: { accountId: string; userId: string };
  let other: { accountId: string; userId: string };
  let engineSession: string;
  let bridgeSession: string;
  const owner = () => ({ accountId: A.accountId, userId: A.userId });

  async function call(identity: { accountId: string; userId: string }, method: string, urlPath: string, body?: unknown) {
    const headers = new Headers({ cookie: `${SESSION_COOKIE_NAME}=${await signSession(identity)}`, accept: 'application/json' });
    if (body !== undefined) headers.set('content-type', 'application/json');
    const res = await handleApiRequest(new Request(`http://localhost/api/v1${urlPath}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), appUserPool, platformOpsPool, ROUTES);
    return { status: res.status, body: (await res.json().catch(() => null)) as Json };
  }
  const q = (sql: string, params: unknown[] = []) => admin.query(sql, params);
  const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();

  async function session(id: string, heardAgoS: number, extra: { ages?: object; first?: number; kind?: 'engine' | 'bridge' } = {}) {
    await q(
      `INSERT INTO engine_sessions (id, account_id, runner_id, repo_id, engine_instance_id, engine_version, first_event_at, last_event_at, last_heard_at, last_heartbeat_at, source_ages_s, session_kind)
       VALUES ($1, $2, $3, $4, $5, '1.0.0', $6, $7, $7, $7, $8, $9)`,
      [id, A.accountId, runnerId, A.repoId, randomUUID(), ago(extra.first ?? 7200), ago(heardAgoS), extra.ages ? JSON.stringify(extra.ages) : null, extra.kind ?? 'engine'],
    );
  }
  let runnerId: string;

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = 's'.repeat(32);
    process.env.FX_CURSOR_KEY_V1 = randomBytes(32).toString('base64');
    A = await seedAccount(admin, randomUUID());
    const m = await seedAccountWithMember(admin, { role: 'member' });
    other = m;
    member = { accountId: A.accountId, userId: randomUUID() };
    await seedUser(admin, member.userId);
    await q(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [A.accountId, member.userId]);
    runnerId = randomUUID();
    await q(
      `INSERT INTO runners (id, account_id, registered_by, public_key_jwk, jkt, credential_mode) VALUES ($1, $2, $3, '{"kty":"OKP","crv":"Ed25519","x":"AAAA"}', $4, 'subscription')`,
      [runnerId, A.accountId, A.userId, 'k'.repeat(43)],
    );
    await q(`UPDATE repos SET execution_mode = 'runner_local', gh_repo_id = 9001 WHERE id = $1`, [A.repoId]);
    await q(`INSERT INTO engine_bridge_settings (account_id, watch_enabled) VALUES ($1, true)`, [A.accountId]);
    await q(`INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)`, [A.accountId, A.repoId]);
  });
  afterAll(async () => {
    delete process.env.FX_SESSION_SECRET;
    delete process.env.FX_CURSOR_KEY_V1;
    engineSettingsDeps.getVisibility = null;
    admin.release();
    await Promise.all([adminPool.end(), appUserPool.end(), platformOpsPool.end()]);
  });

  beforeEach(async () => {
    await q(`DELETE FROM engine_sessions WHERE account_id = $1`, [A.accountId]);
    engineSession = randomUUID();
    bridgeSession = randomUUID();
    // The engine session was last heard 10 minutes ago (the engine crashed); the bridge session is newer and heard now. A hole sits in the ENGINE session.
    await session(engineSession, 600, { ages: { loop: 30, team_log: 40, plan: 50, merge_queue: 60 }, first: 7200 });
    await session(bridgeSession, 5, { first: 60, kind: 'bridge' });
    await q(`INSERT INTO engine_session_gaps (account_id, session_id, from_seq, to_seq, before_ts) VALUES ($1, $2, 10, 14, now() - interval '2 hours')`, [A.accountId, engineSession]);
  });

  it('repos: the repo with its runner name, and liveness from the newest word of either session', async () => {
    const r = await call(owner(), 'GET', '/engine/repos');
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0]).toMatchObject({ repo_id: A.repoId, liveness: 'live', watch_enabled: true, operate_enabled: false, session_id: bridgeSession });
    expect(r.body.items[0].runner_name).toMatch(/^Unnamed runner \(/);
    expect(freeText(r.body)).toEqual([]);
    await q(`UPDATE runners SET revoked_at = now() WHERE id = $1`, [runnerId]);
    expect((await call(owner(), 'GET', '/engine/repos')).body.items[0].liveness).toBe('runner_removed');
    await q(`UPDATE runners SET revoked_at = NULL WHERE id = $1`, [runnerId]);
    await q(`UPDATE engine_sessions SET last_heard_at = now() - interval '200 seconds' WHERE account_id = $1`, [A.accountId]);
    expect((await call(owner(), 'GET', '/engine/repos')).body.items[0].liveness).toBe('stale');
    await q(`DELETE FROM engine_sessions WHERE account_id = $1`, [A.accountId]);
    const none = (await call(owner(), 'GET', '/engine/repos')).body;
    expect(none.items[0]).toMatchObject({ liveness: 'never', runner_name: null });
    expect(none.as_of).toMatch(ISO);
  });

  it('repos: a named runner shows its stored name; an unnamed one shows its registrant the way the fleet page does, and two unnamed runners differ', async () => {
    await q(`UPDATE users SET name = $2 WHERE id = $1`, [A.userId, 'Ada Owner']);
    await q(`UPDATE users SET name = $2 WHERE id = $1`, [member.userId, 'Ben Member']);
    const mk = async (registeredBy: string, name: string | null) => {
      const id = randomUUID();
      await q(`INSERT INTO runners (id, account_id, registered_by, public_key_jwk, jkt, credential_mode) VALUES ($1, $2, $3, '{"kty":"OKP","crv":"Ed25519","x":"AAAA"}', $4, 'subscription')`, [id, A.accountId, registeredBy, randomBytes(32).toString('base64url')]);
      if (name !== null) await q(`INSERT INTO runner_settings (runner_id, account_id, name) VALUES ($1, $2, $3)`, [id, A.accountId, name]);
      return id;
    };
    const nameOf = async (runner: string): Promise<string> => {
      await q(`UPDATE engine_sessions SET runner_id = $1 WHERE id = $2`, [runner, bridgeSession]);
      const r = (await call(owner(), 'GET', '/engine/repos')).body;
      expect(r.items[0]).toMatchObject({ runner_id: runner });
      return r.items[0].runner_name;
    };
    const named = await mk(A.userId, 'Build box');
    const byBen = await mk(member.userId, null);
    const byAda = await mk(A.userId, null);
    const byNobody = await mk(other.userId, null);
    expect(await nameOf(named)).toBe('Build box');
    expect(await nameOf(byBen)).toBe('Unnamed runner (Ben Member)');
    expect(await nameOf(byAda)).toBe('Unnamed runner (Ada Owner)');
    expect(await nameOf(byNobody)).toBe('Unnamed runner (A team member)');
    expect(await nameOf(runnerId)).toBe('Unnamed runner (Ada Owner)');
  });

  it('merged sessions: a hole in the engine session shows although the bridge session is newest, and the source ages come from the engine session', async () => {
    const r = await call(owner(), 'GET', `/engine/repos/${A.repoId}/lanes`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ items: [], next_cursor: null, missing_events: 5, source_ages_s: { loop: 30, team_log: 40, plan: 50, merge_queue: 60 } });
    expect(r.body.gaps).toHaveLength(1);
    expect(r.body.gaps[0]).toMatchObject({ from_seq: 10, to_seq: 14 });
    expect(r.body.heard_age_s).toBeLessThan(30);
    expect(Date.now() - Date.parse(r.body.as_of)).toBeLessThan(30_000);
  });

  it('agents: running and unknown by the derived rules, stopped only under recent, newest first, never "running" for a dead session or a 3 h old start', async () => {
    const ins = (session: string, agent: string, startedAgoS: number | null, stoppedAgoS: number | null) =>
      q(`INSERT INTO engine_agents (account_id, session_id, agent_id, role, discussion, background, started_at, stopped_at, verdict, model) VALUES ($1, $2, $3, 'executor', 842, false, $4, $5, $6, 'sonnet-5')`, [
        A.accountId, session, agent, startedAgoS === null ? null : ago(startedAgoS), stoppedAgoS === null ? null : ago(stoppedAgoS), stoppedAgoS === null ? null : 'done',
      ]);
    await q(`UPDATE engine_sessions SET last_heard_at = now() WHERE id = $1`, [engineSession]);
    const dead = randomUUID();
    await session(dead, 4000, { first: 9000 });
    await ins(engineSession, 'a-live', 600, null);
    await ins(engineSession, 'a-old', 4 * 3600, null);
    await ins(dead, 'a-dead', 600, null);
    await ins(engineSession, 'a-done1', 900, 800);
    await ins(engineSession, 'a-done2', 500, 100);
    await ins(engineSession, 'a-ancient', 90000, 86500);
    const running = (await call(owner(), 'GET', `/engine/repos/${A.repoId}/agents?state=running`)).body;
    const states = Object.fromEntries(running.items.map((a: Json) => [a.agent_id, a.state]));
    expect(states).toEqual({ 'a-live': 'running', 'a-old': 'unknown', 'a-dead': 'unknown' });
    expect(running.items[0]).toMatchObject({ role: 'executor', discussion: 842, background: false, model: 'sonnet-5', stopped_at: null, verdict: null });
    const recent = (await call(owner(), 'GET', `/engine/repos/${A.repoId}/agents?state=recent`)).body;
    expect(recent.items.map((a: Json) => a.agent_id)).toEqual(['a-done2', 'a-done1']);
    expect(recent.items.every((a: Json) => a.state === 'stopped')).toBe(true);
    const p1 = (await call(owner(), 'GET', `/engine/repos/${A.repoId}/agents?state=running&limit=2`)).body;
    expect(p1.items).toHaveLength(2);
    expect(p1.next_cursor).toBeTruthy();
    const p2 = (await call(owner(), 'GET', `/engine/repos/${A.repoId}/agents?state=running&limit=2&cursor=${p1.next_cursor}`)).body;
    expect([...p1.items, ...p2.items].map((a: Json) => a.agent_id).sort()).toEqual(['a-dead', 'a-live', 'a-old']);
    expect(p2.next_cursor).toBeNull();
    expect(freeText(running)).toEqual([]);
  });

  it('lanes, gates, asks and log: the newest per key, the pr filter, open or all, and keyset pages with no row lost', async () => {
    const lane = (s: string, pr: number, state: string, agoS: number) => q(`INSERT INTO engine_lanes (account_id, session_id, pr, discussion, state, updated_at) VALUES ($1, $2, $3, 842, $4, $5)`, [A.accountId, s, pr, state, ago(agoS)]);
    await lane(engineSession, 7, 'queued', 900);
    await lane(bridgeSession, 7, 'testing', 100);
    await lane(engineSession, 8, 'merged', 50);
    const lanes = (await call(owner(), 'GET', `/engine/repos/${A.repoId}/lanes`)).body;
    expect(lanes.items.map((l: Json) => [l.pr, l.state])).toEqual([[8, 'merged'], [7, 'testing']]);
    const gate = (pr: number, g: string, result: string, sha: string, agoS: number) =>
      q(`INSERT INTO engine_gate_receipts (account_id, session_id, pr, gate, result, head_sha, at) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [A.accountId, engineSession, pr, g, result, sha.repeat(40), ago(agoS)]);
    await gate(7, 'gate1', 'fail', 'a', 500);
    await gate(7, 'gate1', 'pass', 'b', 100);
    await gate(7, 'code_review', 'pass', 'b', 90);
    await gate(8, 'gate1', 'pass', 'c', 80);
    await gate(99, 'gate1', 'pass', 'd', 3 * 86400);
    const gates = (await call(owner(), 'GET', `/engine/repos/${A.repoId}/gates`)).body;
    expect(gates.items.map((g: Json) => `${g.pr}:${g.gate}:${g.result}`).sort()).toEqual(['7:code_review:pass', '7:gate1:pass', '8:gate1:pass']);
    const one = (await call(owner(), 'GET', `/engine/repos/${A.repoId}/gates?pr=99`)).body;
    expect(one.items.map((g: Json) => g.pr)).toEqual([99]);
    expect((await call(owner(), 'GET', `/engine/repos/${A.repoId}/gates?pr=abc`)).status).toBe(422);
    const ask = (id: string, cleared: boolean) =>
      q(`INSERT INTO engine_asks (account_id, session_id, ask_id, ask_kind, source, discussion, raised_at, cleared_at, how) VALUES ($1, $2, $3, 'owner_decision', 'team_log', 842, now(), $4, $5)`, [A.accountId, engineSession, id.repeat(16).slice(0, 16), cleared ? new Date() : null, cleared ? 'withdrawn' : null]);
    await ask('a', false);
    await ask('b', true);
    expect((await call(owner(), 'GET', `/engine/repos/${A.repoId}/asks`)).body.items).toHaveLength(1);
    expect((await call(owner(), 'GET', `/engine/repos/${A.repoId}/asks?state=all`)).body.items).toHaveLength(2);
    for (let i = 0; i < 5; i++) {
      await q(`INSERT INTO engine_events (session_id, seq, account_id, ts, kind, body) VALUES ($1, $2, $3, $4, 'team_log_line', $5)`, [
        engineSession, 20 + i, A.accountId, ago(100 - i), JSON.stringify({ line_id: String(i).repeat(16), actor_role: 'team-lead', category: 'merged', pr: 7 }),
      ]);
    }
    const seen: string[] = [];
    let cursor = '';
    for (let n = 0; n < 5; n++) {
      const pg = (await call(owner(), 'GET', `/engine/repos/${A.repoId}/log?limit=2${cursor}`)).body;
      expect(pg.items.length).toBeLessThanOrEqual(2);
      seen.push(...pg.items.map((l: Json) => l.line_id));
      if (pg.next_cursor === null) break;
      cursor = `&cursor=${pg.next_cursor}`;
    }
    expect(seen).toEqual([4, 3, 2, 1, 0].map((i) => String(i).repeat(16)));
    expect((await call(owner(), 'GET', `/engine/repos/${A.repoId}/log?cursor=not-a-cursor`)).status).toBe(422);
    expect((await call(owner(), 'GET', `/engine/repos/${A.repoId}/log?limit=201`)).status).toBe(422);
    const all = [lanes, gates, (await call(owner(), 'GET', `/engine/repos/${A.repoId}/log`)).body];
    for (const b of all) expect(freeText(b)).toEqual([]);
  });

  it('free text: every GET route under /api/v1/engine, taken from the route list, serves only ids, enums, counts, dates and cloud-side names', async () => {
    await q(`INSERT INTO engine_agents (account_id, session_id, agent_id, role, discussion, background, started_at, model) VALUES ($1, $2, 'walk-agent', 'executor', 842, false, $3, 'sonnet-5')`, [A.accountId, engineSession, ago(300)]);
    await q(`INSERT INTO engine_lanes (account_id, session_id, pr, discussion, state, updated_at) VALUES ($1, $2, 7, 842, 'queued', now())`, [A.accountId, engineSession]);
    await q(`INSERT INTO engine_gate_receipts (account_id, session_id, pr, gate, result, head_sha, at) VALUES ($1, $2, 7, 'gate1', 'pass', $3, now())`, [A.accountId, engineSession, 'a'.repeat(40)]);
    await q(`INSERT INTO engine_asks (account_id, session_id, ask_id, ask_kind, source, discussion, raised_at) VALUES ($1, $2, $3, 'owner_decision', 'team_log', 842, now())`, [A.accountId, engineSession, 'b'.repeat(16)]);
    await q(`INSERT INTO engine_events (session_id, seq, account_id, ts, kind, body) VALUES ($1, 90, $2, now(), 'team_log_line', $3)`, [engineSession, A.accountId, JSON.stringify({ line_id: 'c'.repeat(16), actor_role: 'team-lead', category: 'merged', pr: 7 })]);
    await q(`INSERT INTO engine_agent_usage (account_id, session_id, subject_kind, subject_id, credential_mode, model, input_tokens, output_tokens, api_equivalent_usd, price_table_version) VALUES ($1, $2, 'agent', 'walk-agent', 'subscription', 'sonnet-5', 100, 50, 1.5, 'v1')`, [A.accountId, engineSession]);
    engineSettingsDeps.getVisibility = () => async () => 'private';
    const routes = ROUTES.filter((r) => r.method === 'GET' && r.path.startsWith('/api/v1/engine') && engineReadRoutes.includes(r));
    expect(routes.map((r) => r.operationId).sort()).toEqual(['getEngineSettings', 'getEngineStats', 'getEngineUsage', 'listEngineAgents', 'listEngineAsks', 'listEngineGates', 'listEngineLanes', 'listEngineLog', 'listEngineRepos']);
    for (const r of routes) {
      const query = r.path.endsWith('/asks') ? '?state=all' : r.path.endsWith('/agents') ? '?state=running' : '';
      const res = await call(owner(), 'GET', r.path.replace('/api/v1', '').replace('{id}', A.repoId) + query);
      expect(res.status, r.path).toBe(200);
      expect(freeText(res.body), r.path).toEqual([]);
      if (Array.isArray(res.body.items)) expect(res.body.items.length, `${r.path} has rows to walk`).toBeGreaterThan(0);
    }
    // The walker itself: text the engine could have typed is reported, and the exempt keys are the only ones skipped.
    expect(freeText({ items: [{ note: 'free text here', row_key: 'any thing', runner_name: 'My box' }] })).toEqual(['$.items[0].note="free text here"']);
  });

  it('another account, an unticked repo and a malformed id are all 404', async () => {
    expect((await call(other, 'GET', `/engine/repos/${A.repoId}/agents`)).status).toBe(404);
    expect((await call(owner(), 'GET', `/engine/repos/${randomUUID()}/agents`)).status).toBe(404);
    expect((await call(owner(), 'GET', `/engine/repos/nope/log`)).status).toBe(404);
    expect((await call(other, 'GET', '/engine/repos')).body.items).toEqual([]);
  });

  it('settings: any member reads (can_edit by role); a member cannot write; public and non-runner repos are refused; operate needs watch; each change is audited', async () => {
    engineSettingsDeps.getVisibility = () => async () => 'private';
    const read = (await call(member, 'GET', '/engine/settings')).body;
    expect(read).toMatchObject({ watch_enabled: true, operate_enabled: false, can_edit: false });
    expect(read.repos.find((x: Json) => x.repo_id === A.repoId)).toMatchObject({ enabled: true, eligible: true, refusal: null });
    expect((await call(owner(), 'GET', '/engine/settings')).body.can_edit).toBe(true);
    expect((await call(member, 'PUT', '/engine/settings', { watch_enabled: false })).status).toBe(403);
    expect((await call(member, 'PUT', '/engine/settings/delete-data')).status).toBe(403);
    expect((await call(owner(), 'PUT', '/engine/settings', { operate_enabled: true, extra: 1 })).status).toBe(422);

    const audits = async () => Number((await q(`SELECT count(*) AS n FROM audit_log WHERE account_id = $1 AND action = 'engine_bridge.settings_changed'`, [A.accountId])).rows[0].n);
    const before = await audits();
    expect((await call(owner(), 'PUT', '/engine/settings', { operate_enabled: true })).body.operate_enabled).toBe(true);
    expect(await audits()).toBe(before + 1);
    const off = await call(owner(), 'PUT', '/engine/settings', { watch_enabled: false });
    expect(off.status).toBe(422);
    expect((await call(owner(), 'PUT', '/engine/settings', { operate_enabled: false, watch_enabled: false })).body).toMatchObject({ watch_enabled: false, operate_enabled: false });

    const second = randomUUID();
    const third = randomUUID();
    for (const [id, gh, name, mode] of [[second, 9002, 'second', 'runner_local'], [third, 9003, 'third', 'sandbox']] as const) {
      await q(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name, execution_mode) SELECT $1, account_id, installation_id, $2, 'team', 'acme', $3, $4 FROM repos WHERE id = $5`, [id, gh, name, mode, A.repoId]);
    }
    engineSettingsDeps.getVisibility = () => async () => 'public';
    expect(await call(owner(), 'PUT', '/engine/settings', { repo_ids: [A.repoId, second] })).toMatchObject({ status: 409, body: { error: { code: 'public_repo' } } });
    expect((await call(owner(), 'GET', '/engine/settings')).body.repos.find((x: Json) => x.repo_id === second)).toMatchObject({ full_name: 'acme/second', eligible: false, refusal: 'public_repo' });
    engineSettingsDeps.getVisibility = null;
    expect((await call(owner(), 'PUT', '/engine/settings', { repo_ids: [A.repoId, second] })).status).toBe(409);
    engineSettingsDeps.getVisibility = () => async () => 'private';
    expect(await call(owner(), 'PUT', '/engine/settings', { repo_ids: [A.repoId, third] })).toMatchObject({ status: 409, body: { error: { code: 'repo_not_runner_local' } } });
    const ok = await call(owner(), 'PUT', '/engine/settings', { repo_ids: [A.repoId, second] });
    expect(ok.status).toBe(200);
    expect(ok.body.repos.filter((x: Json) => x.enabled).map((x: Json) => x.repo_id).sort()).toEqual([A.repoId, second].sort());
    await call(owner(), 'PUT', '/engine/settings', { repo_ids: [A.repoId] });
    expect((await call(owner(), 'PUT', '/engine/settings', { repo_ids: [randomUUID()] })).status).toBe(404);
  });

  it('settings: when the GitHub visibility call fails in any way, ticking a new repo is refused with 409 and nothing is written (fail closed)', async () => {
    const fresh = randomUUID();
    await q(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name, execution_mode) SELECT $1, account_id, installation_id, 9100, 'team', 'acme', 'fresh', 'runner_local' FROM repos WHERE id = $2`, [fresh, A.repoId]);
    const ticked = async () => (await q(`SELECT repo_id FROM engine_bridge_repos WHERE account_id = $1 ORDER BY repo_id`, [A.accountId])).rows.map((r) => r.repo_id);
    const audits = async () => Number((await q(`SELECT count(*) AS n FROM audit_log WHERE account_id = $1 AND action = 'engine_bridge.settings_changed'`, [A.accountId])).rows[0].n);
    const failures: Record<string, () => (accountId: string, repoId: string) => Promise<'private' | 'public' | 'unknown'>> = {
      'the reader rejects': () => () => Promise.reject(new Error('github is down')),
      'the reader throws before returning a promise': () => () => {
        throw new Error('github client broke');
      },
      'the reader factory throws': () => {
        throw new Error('no github client');
      },
      'the reader answers something that is not private': () => async () => 'unknown',
    };
    try {
      const rowsBefore = await ticked();
      const auditsBefore = await audits();
      for (const [name, deps] of Object.entries(failures)) {
        engineSettingsDeps.getVisibility = deps;
        const put = await call(owner(), 'PUT', '/engine/settings', { repo_ids: [A.repoId, fresh] });
        expect(put, name).toMatchObject({ status: 409, body: { error: { code: 'public_repo' } } });
        expect(await ticked(), `${name}: nothing ticked`).toEqual(rowsBefore);
        expect(await audits(), `${name}: nothing audited`).toBe(auditsBefore);
        const view = (await call(owner(), 'GET', '/engine/settings')).body;
        expect(view.repos.find((x: Json) => x.repo_id === fresh), `${name}: the read says refused`).toMatchObject({ eligible: false, refusal: 'public_repo' });
      }
      engineSettingsDeps.getVisibility = () => async () => 'private';
      expect((await call(owner(), 'PUT', '/engine/settings', { repo_ids: [A.repoId, fresh] })).status).toBe(200);
      await call(owner(), 'PUT', '/engine/settings', { repo_ids: [A.repoId] });
    } finally {
      engineSettingsDeps.getVisibility = null;
    }
  });

  it('delete-data: an owner removes every engine row and writes its audit row; the switches stay', async () => {
    await q(`INSERT INTO engine_lanes (account_id, session_id, pr, state, updated_at) VALUES ($1, $2, 1, 'queued', now())`, [A.accountId, engineSession]);
    const r = await call(owner(), 'PUT', '/engine/settings/delete-data');
    expect(r).toMatchObject({ status: 200, body: { deleted_sessions: 2 } });
    expect(Number((await q(`SELECT count(*) AS n FROM engine_lanes WHERE account_id = $1`, [A.accountId])).rows[0].n)).toBe(0);
    expect(Number((await q(`SELECT count(*) AS n FROM audit_log WHERE account_id = $1 AND action = 'engine_bridge.data_deleted'`, [A.accountId])).rows[0].n)).toBeGreaterThanOrEqual(1);
    expect((await call(owner(), 'GET', '/engine/settings')).body.watch_enabled).toBe(false);
  });

  it('engine.changed reaches /events (JSON mode) with ids only, for the account only', async () => {
    const start = (await call(owner(), 'GET', '/events')).body.next_cursor;
    const otherStart = (await call(other, 'GET', '/events')).body.next_cursor;
    await q(`INSERT INTO domain_events (account_id, type, subject_id, payload) VALUES ($1, 'engine.changed', $2, $3)`, [A.accountId, A.repoId, JSON.stringify({ repo_id: A.repoId, session_id: engineSession, last_seq: 14 })]);
    const mine = (await call(owner(), 'GET', `/events?cursor=${start}`)).body;
    const ev = mine.data.find((e: Json) => e.type === 'engine.changed');
    expect(ev.data).toEqual({ repo_id: A.repoId, session_id: engineSession, last_seq: 14 });
    expect((await call(other, 'GET', `/events?cursor=${otherStart}`)).body.data.some((e: Json) => e.type === 'engine.changed')).toBe(false);
  });
  it('engine.changed reaches /events in SSE mode: ids only, the owning account only', async () => {
    const poller = new AccountPoller({ pool: appUserPool, platformOpsPool, activeIntervalMs: 40, idleIntervalMs: 40 });
    const server = await startServer((req) => handleEventsRequest(req, { kind: 'account' }, { pool: appUserPool, platformOpsPool, poller, runPollIntervalMs: 40 }));
    const cookieOf = async (who: { accountId: string; userId: string }) => `${SESSION_COOKIE_NAME}=${await signSession(who)}`;
    const mine = await openSse(`${server.url}/api/v1/events`, { cookie: await cookieOf(owner()) });
    const theirs = await openSse(`${server.url}/api/v1/events`, { cookie: await cookieOf(other) });
    try {
      expect(mine.status).toBe(200);
      expect(mine.headers.get('content-type')).toContain('text/event-stream');
      await mine.waitFor((f) => f.comment === 'ok');
      await theirs.waitFor((f) => f.comment === 'ok');
      const payload = { repo_id: A.repoId, session_id: engineSession, last_seq: 14 };
      await q(`INSERT INTO domain_events (account_id, type, subject_id, payload) VALUES ($1, 'engine.changed', $2, $3)`, [A.accountId, A.repoId, JSON.stringify(payload)]);
      // A marker event on the other account's stream proves that stream is live and has caught up before we assert it saw nothing.
      await q(`INSERT INTO domain_events (account_id, type, payload) VALUES ($1, 'pr.opened', '{}'::jsonb)`, [other.accountId]);
      await eventually(() => mine.events().some((f) => f.event === 'engine.changed'));
      await eventually(() => theirs.events().some((f) => f.event === 'pr.opened'));
      const frame = mine.events().find((f) => f.event === 'engine.changed')!;
      const body = JSON.parse(frame.data!);
      expect(Object.keys(body).sort()).toEqual(['created_at', 'data', 'id', 'type']);
      expect(body.data).toEqual(payload);
      expect(theirs.text()).not.toContain('engine.changed');
      expect(theirs.text()).not.toContain(A.repoId);
    } finally {
      mine.abort();
      theirs.abort();
      await server.close();
    }
  });
});
