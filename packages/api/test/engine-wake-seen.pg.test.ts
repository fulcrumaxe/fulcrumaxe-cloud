import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { WAKE_STAMP_MAX_DB_AGE_S, engineSeen, heardAgeWithSeen, livenessOf, readRepoWakeSeen, type RunnerSeenReader } from '@fx/core/src/engine/panels.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any; // a decoded response body: its shape is what each test asserts

/**
 * A runner that uploads every 5 minutes checks the wake route every 20 s. The engine panels count that check (`seen:<rid>`) as hearing from it, so a quiet but
 * connected machine reads live while the 180 s threshold stays as it is. The stamp is read only for the runner of the account's own repo.
 */
describe('engine liveness from the wake check', () => {
  it('pure: the smaller age wins, no stamp changes nothing, a stamp from the future counts as now', () => {
    const now = new Date('2026-11-17T12:00:00Z');
    expect(heardAgeWithSeen(300, new Date(now.getTime() - 20_000), now)).toBe(20);
    expect(heardAgeWithSeen(30, new Date(now.getTime() - 400_000), now)).toBe(30);
    expect(heardAgeWithSeen(300, null, now)).toBe(300);
    // A repo nobody has heard from stays that way; the stamp does not invent a first word.
    expect(heardAgeWithSeen(null, new Date(now.getTime() - 20_000), now)).toBeNull();
    expect(heardAgeWithSeen(null, null, now)).toBeNull();
    expect(heardAgeWithSeen(300, new Date(now.getTime() + 60_000), now)).toBe(0);
    // The bound: the stamp counts at 420 s of database age and not at 421 s.
    expect(WAKE_STAMP_MAX_DB_AGE_S).toBe(420);
    const fresh = new Date(now.getTime() - 20_000);
    expect(heardAgeWithSeen(420, fresh, now)).toBe(20);
    expect(heardAgeWithSeen(421, fresh, now)).toBe(421);
    expect(heardAgeWithSeen(600, fresh, now)).toBe(600);
    expect(livenessOf({ sessionCount: 1, revoked: false, heardAgeS: heardAgeWithSeen(300, new Date(now.getTime() - 20_000), now) })).toBe('live');
  });

  describe('[pg]', () => {
    let adminPool: Pool;
    let admin: PoolClient;
    let appUserPool: Pool;
    let platformOpsPool: Pool;
    let A: SeedRefs;
    let B: SeedRefs;
    let runnerA: string;
    let runnerB: string;
    let asked: string[][];
    let stamps: Map<string, Date>;
    const q = (sql: string, params: unknown[] = []) => admin.query(sql, params);
    const ago = (s: number) => new Date(Date.now() - s * 1000);
    const reader: RunnerSeenReader = async (ids) => {
      asked.push([...ids]);
      return new Map([...stamps].filter(([id]) => ids.includes(id)));
    };

    async function call(identity: { accountId: string; userId: string }, urlPath: string) {
      const headers = new Headers({ cookie: `${SESSION_COOKIE_NAME}=${await signSession(identity)}`, accept: 'application/json' });
      const res = await handleApiRequest(new Request(`http://localhost/api/v1${urlPath}`, { method: 'GET', headers }), appUserPool, platformOpsPool, ROUTES);
      return { status: res.status, body: (await res.json().catch(() => null)) as Json };
    }
    async function runner(account: SeedRefs): Promise<string> {
      const id = randomUUID();
      await q(`INSERT INTO runners (id, account_id, registered_by, public_key_jwk, jkt, credential_mode) VALUES ($1, $2, $3, '{"kty":"OKP","crv":"Ed25519","x":"AAAA"}', $4, 'subscription')`, [id, account.accountId, account.userId, randomBytes(32).toString('base64url')]);
      return id;
    }
    async function session(account: SeedRefs, runnerId: string, repoId: string, heardAgoS: number, firstAgoS = 7200, kind: 'engine' | 'bridge' = 'bridge'): Promise<string> {
      const id = randomUUID();
      await q(
        `INSERT INTO engine_sessions (id, account_id, runner_id, repo_id, engine_instance_id, engine_version, first_event_at, last_event_at, last_heard_at, last_heartbeat_at, session_kind)
         VALUES ($1, $2, $3, $4, $5, '1.0.0', $6, $7, $7, $7, $8)`,
        [id, account.accountId, runnerId, repoId, randomUUID(), ago(firstAgoS).toISOString(), ago(heardAgoS).toISOString(), kind],
      );
      return id;
    }
    const owner = () => ({ accountId: A.accountId, userId: A.userId });

    beforeAll(async () => {
      adminPool = createPool(process.env.API_DATABASE_URL!);
      admin = await adminPool.connect();
      appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
      platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
      process.env.FX_SESSION_SECRET = 's'.repeat(32);
      process.env.FX_CURSOR_KEY_V1 = randomBytes(32).toString('base64');
      A = await seedAccount(admin, randomUUID());
      B = await seedAccount(admin, randomUUID());
      runnerA = await runner(A);
      runnerB = await runner(B);
      for (const [acct, ghId] of [[A, 9101], [B, 9102]] as const) {
        await q(`UPDATE repos SET execution_mode = 'runner_local', gh_repo_id = $2 WHERE id = $1`, [acct.repoId, ghId]);
        await q(`INSERT INTO engine_bridge_settings (account_id, watch_enabled) VALUES ($1, true)`, [acct.accountId]);
        await q(`INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)`, [acct.accountId, acct.repoId]);
      }
    });
    afterAll(async () => {
      delete process.env.FX_SESSION_SECRET;
      delete process.env.FX_CURSOR_KEY_V1;
      engineSeen.reader = null;
      admin.release();
      await Promise.all([adminPool.end(), appUserPool.end(), platformOpsPool.end()]);
    });
    beforeEach(async () => {
      await q(`DELETE FROM engine_sessions WHERE account_id = ANY($1::uuid[])`, [[A.accountId, B.accountId]]);
      asked = [];
      stamps = new Map();
      engineSeen.reader = () => reader;
      // Account B's runner checks the wake route right now; account A's repo must never read that.
      stamps.set(runnerB, ago(5));
      // The quiet machine: its last upload was 5 minutes ago.
      await session(A, runnerA, A.repoId, 300);
    });
    afterEach(() => {
      engineSeen.reader = null;
    });

    it('a quiet machine (no upload for 5 minutes) with a fresh wake check reads live, on the repo list and on a panel', async () => {
      stamps.set(runnerA, ago(20));
      const list = (await call(owner(), '/engine/repos')).body;
      expect(list.items[0]).toMatchObject({ repo_id: A.repoId, liveness: 'live' });
      expect(list.items[0].last_heard_at).toBe(stamps.get(runnerA)!.toISOString());
      const panel = (await call(owner(), `/engine/repos/${A.repoId}/agents?state=recent`)).body;
      expect(panel.heard_age_s).toBeLessThanOrEqual(30);
      expect(panel.heard_age_s).toBeGreaterThanOrEqual(0);
    });

    it('a stale wake check and no upload reads stale; with no stamp at all the database alone decides', async () => {
      stamps.set(runnerA, ago(400));
      expect((await call(owner(), '/engine/repos')).body.items[0].liveness).toBe('stale');
      expect((await call(owner(), `/engine/repos/${A.repoId}/agents?state=recent`)).body.heard_age_s).toBeGreaterThanOrEqual(299);
      stamps.delete(runnerA);
      expect((await call(owner(), '/engine/repos')).body.items[0].liveness).toBe('stale');
    });

    it('the stamp counts only while the database\'s own word is at most 420 s old: 600 s plus a fresh stamp reads stale on the list, a panel and the plan; 300 s reads live', async () => {
      stamps.set(runnerA, ago(20));
      const plan = async (sessionId: string) => {
        await q(`DELETE FROM engine_plan_snapshots WHERE account_id = $1`, [A.accountId]);
        await q(
          `INSERT INTO engine_plan_snapshots (account_id, session_id, repo_id, plan_date, snapshot_id, chunk_count, items, roadmap, started_seq, completed_seq, snapshot_at) VALUES ($1, $2, $3, '2026-11-17', 'x', 1, '[]', '[]', 0, 0, now())`,
          [A.accountId, sessionId, A.repoId],
        );
        return (await call(owner(), `/engine/repos/${A.repoId}/plan`)).body;
      };
      const engineSession = await session(A, runnerA, A.repoId, 300, 3600, 'engine');
      // The newest heard word of the repo is the bridge session's, 300 s ago: inside the bound.
      expect((await call(owner(), '/engine/repos')).body.items[0].liveness).toBe('live');
      expect((await call(owner(), `/engine/repos/${A.repoId}/agents?state=recent`)).body.heard_age_s).toBeLessThanOrEqual(30);
      expect((await plan(engineSession)).heard_age_s).toBeLessThanOrEqual(30);
      // Now every session was last heard 600 s ago (the bridge is dead while its daemon still checks the wake route): outside the bound.
      await q(`UPDATE engine_sessions SET last_heard_at = now() - interval '600 seconds' WHERE account_id = $1`, [A.accountId]);
      const list = (await call(owner(), '/engine/repos')).body;
      expect(list.items[0].liveness).toBe('stale');
      expect(Date.parse(list.items[0].last_heard_at)).toBeLessThan(Date.now() - 590_000);
      expect((await call(owner(), `/engine/repos/${A.repoId}/agents?state=recent`)).body.heard_age_s).toBeGreaterThanOrEqual(599);
      expect((await plan(engineSession)).heard_age_s).toBeGreaterThanOrEqual(599);
    });

    it('a running agent stays running (Stop stays available) through a quiet 5 minutes with a fresh wake check, and goes unknown past the bound or without one', async () => {
      const engineSession = await session(A, runnerA, A.repoId, 300, 3600, 'engine');
      await q(`INSERT INTO engine_agents (account_id, session_id, agent_id, role, discussion, background, started_at, model) VALUES ($1, $2, 'quiet-agent', 'executor', 842, false, $3, 'sonnet-5')`, [A.accountId, engineSession, ago(600).toISOString()]);
      const state = async () => (await call(owner(), `/engine/repos/${A.repoId}/agents?state=running`)).body.items.find((i: Json) => i.agent_id === 'quiet-agent')?.state;
      stamps.set(runnerA, ago(20));
      expect(await state()).toBe('running');
      // No wake stamp: the engine session itself was last heard 300 s ago, past the 180 s rule.
      stamps.delete(runnerA);
      expect(await state()).toBe('unknown');
      // A stale stamp does not keep it running either.
      stamps.set(runnerA, ago(400));
      expect(await state()).toBe('unknown');
      // And a fresh stamp does not outlive the bound: the session was last heard 600 s ago.
      stamps.set(runnerA, ago(20));
      await q(`UPDATE engine_sessions SET last_heard_at = now() - interval '600 seconds' WHERE id = $1`, [engineSession]);
      expect(await state()).toBe('unknown');
    });

    it('a wake check never makes a removed runner live, and never lowers a fresher upload', async () => {
      stamps.set(runnerA, ago(20));
      await q(`UPDATE runners SET revoked_at = now() WHERE id = $1`, [runnerA]);
      asked = [];
      expect((await call(owner(), '/engine/repos')).body.items[0].liveness).toBe('runner_removed');
      // A removed runner is not looked up at all.
      expect(asked).toEqual([]);
      await q(`UPDATE runners SET revoked_at = NULL WHERE id = $1`, [runnerA]);
      stamps.set(runnerA, ago(900));
      await q(`UPDATE engine_sessions SET last_heard_at = now() WHERE account_id = $1`, [A.accountId]);
      const body = (await call(owner(), '/engine/repos')).body;
      expect(body.items[0].liveness).toBe('live');
      expect(Date.parse(body.items[0].last_heard_at)).toBeGreaterThan(Date.now() - 10_000);
    });

    it('a reader that fails leaves the database word, and does not fail the panel', async () => {
      engineSeen.reader = () => async () => {
        throw new Error('cache down');
      };
      const r = await call(owner(), '/engine/repos');
      expect(r.status).toBe(200);
      expect(r.body.items[0].liveness).toBe('stale');
    });

    it('asks the cache only about the runner of the account\'s own repo', async () => {
      stamps.set(runnerA, ago(20));
      await call(owner(), '/engine/repos');
      expect(asked).toEqual([[runnerA]]);
    });

    it('a foreign account id reads no stamp, through the RLS-bypassing client, and the cache is not asked (tenant rule)', async () => {
      stamps.set(runnerA, ago(20));
      // B's account with A's repo: nothing, and no cache read at all.
      expect((await readRepoWakeSeen(admin, B.accountId, [A.repoId])).size).toBe(0);
      // A's account with B's repo: nothing either.
      expect((await readRepoWakeSeen(admin, A.accountId, [B.repoId])).size).toBe(0);
      expect(asked).toEqual([]);
      // Even with a session of B's repo on B's runner, A's account cannot reach it.
      await session(B, runnerB, B.repoId, 300);
      expect((await readRepoWakeSeen(admin, A.accountId, [B.repoId])).size).toBe(0);
      expect(asked).toEqual([]);
      // The same call for B's own repo does read B's runner.
      expect([...(await readRepoWakeSeen(admin, B.accountId, [B.repoId])).keys()]).toEqual([B.repoId]);
      expect(asked).toEqual([[runnerB]]);
    });

    it('a second repo of the same account, served by another runner, is not read for this repo', async () => {
      const other = await runner(A);
      const repo2 = randomUUID();
      await q(`INSERT INTO repos (id, account_id, gh_repo_id, product) VALUES ($1, $2, $3, 'team')`, [repo2, A.accountId, Math.floor(Math.random() * 1e9)]);
      await session(A, other, repo2, 10, 60);
      stamps.set(other, ago(5));
      stamps.set(runnerA, ago(20));
      const seen = await readRepoWakeSeen(admin, A.accountId, [A.repoId]);
      expect([...seen.keys()]).toEqual([A.repoId]);
      expect(seen.get(A.repoId)!.getTime()).toBe(stamps.get(runnerA)!.getTime());
      expect(asked).toEqual([[runnerA]]);
    });
  });
});
