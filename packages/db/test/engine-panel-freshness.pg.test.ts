import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENGINE_PANEL_KINDS, readEnginePanelAsOf, readEngineRepoFreshness, type EnginePanel } from '../src/engineBridge.js';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { insertRunner } from './helpers/runnerFixtures.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

/**
 * D#845 ON-25a: what the Team app's per-repo reads say about each panel's age and about the events the machine holds back. Every read names the account and the repo, so the proofs
 * here are: a second repo of the SAME account reads nothing of the first, another account's repo reads nothing, the RLS-bypassing admin client with a foreign account id reads nothing,
 * and a tenant client of another account reads nothing through row security.
 */
const PANELS: EnginePanel[] = ['agents', 'lanes', 'gates', 'asks', 'log', 'usage', 'stats'];
const BODY: Record<string, object> = {
  agent_started: { spawn_id: 'toolu_01AbC', role: 'executor', background: true, isolation: 'worktree', discussion: 12, model: 'sonnet-5' },
  agent_linked: { spawn_id: 'toolu_01AbC', agent_id: 'agent-1' },
  agent_stopped: { agent_id: 'agent-1', role: 'code-reviewer', verdict: 'pass', credential_mode: 'subscription', duration_s: 41 },
  merge_lane: { pr: 5, state: 'queued', discussion: 3 },
  merged: { pr: 5, closes: true },
  gate_receipt: { pr: 5, gate: 'gate1', result: 'pass', head_sha: 'a'.repeat(40) },
  ask_raised: { ask_id: '0123456789abcdef', ask_kind: 'owner_decision', source: 'team_log' },
  ask_cleared: { ask_id: '0123456789abcdef', how: 'answered_cloud' },
  team_log_line: { line_id: '0123456789abcdef', actor_role: 'team-lead', category: 'merged', pr: 5 },
  tick_ended: { tick_kind: 'loop', credential_mode: 'api_key', outcome: 'ok' },
  engine_heartbeat: { origin: 'interactive', source_ages_s: { loop: 5 } },
};

describe('engine panel freshness [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;
  let second: string;
  let runnerA: string;
  let runnerB: string;
  let engineA: string;
  let detailA: string;
  let engineSecond: string;
  let engineB: string;
  let seqCounter = 0;

  const session = async (account: SeedRefs, runner: string, repo: string, kind: 'engine' | 'bridge' | 'detail') => {
    const id = randomUUID();
    await admin.query(`INSERT INTO engine_sessions (id, account_id, runner_id, repo_id, engine_instance_id, engine_version, session_kind) VALUES ($1, $2, $3, $4, $5, '1.2.3', $6)`, [id, account.accountId, runner, repo, randomUUID(), kind]);
    return id;
  };
  /** One event with the cloud's receive time `ago` before now. */
  const event = async (account: SeedRefs, sessionId: string, kind: string, ago: string, body: object = BODY[kind] ?? {}, seq?: number) => {
    await admin.query(`INSERT INTO engine_events (session_id, seq, account_id, ts, kind, body, received_at) VALUES ($1, $2, $3, now() - interval '9 days', $4, $5::jsonb, now() - $6::interval)`, [sessionId, seq ?? seqCounter++, account.accountId, kind, JSON.stringify(body), ago]);
  };
  const gap = async (account: SeedRefs, sessionId: string, from: number, to: number, held: boolean) => {
    await admin.query(`INSERT INTO engine_session_gaps (account_id, session_id, from_seq, to_seq, held) VALUES ($1, $2, $3, $4, $5)`, [account.accountId, sessionId, from, to, held]);
  };
  const asOfMsAgo = async (panel: EnginePanel, repo = a.repoId, account = a) => {
    const at = await readEnginePanelAsOf(admin, account.accountId, repo, panel);
    return at === null ? null : Math.round((Date.now() - Date.parse(at)) / 60_000);
  };
  const asA = <T>(run: (c: PoolClient) => Promise<T>) => withTenant(appPool, a.accountId, a.userId, run);

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    runnerA = await insertRunner(admin, a.accountId, a.userId);
    runnerB = await insertRunner(admin, b.accountId, b.userId);
    second = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name, execution_mode) VALUES ($1, $2, $3, 'team', 'acme', 'second', 'runner_local')`, [second, a.accountId, Math.floor(Math.random() * 1e9)]);
    engineA = await session(a, runnerA, a.repoId, 'engine');
    detailA = await session(a, runnerA, a.repoId, 'detail');
    engineSecond = await session(a, runnerA, second, 'engine');
    engineB = await session(b, runnerB, b.repoId, 'engine');
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM engine_sessions WHERE account_id = ANY ($1::uuid[])`, [[a.accountId, b.accountId]]);
    await admin.query(`DELETE FROM repos WHERE id = $1`, [second]);
    admin.release();
    await adminPool.end();
    await appPool.end();
  });

  describe('each panel reads the newest event of its own kinds', () => {
    it('a panel with no event of its kinds has no stamp of its own', async () => {
      for (const p of PANELS) expect(await readEnginePanelAsOf(admin, a.accountId, a.repoId, p), p).toBeNull();
    });

    it('answers per panel, from every session of the repo (the engine\'s and the detail session), by the cloud\'s receive time', async () => {
      await event(a, engineA, 'ask_raised', '50 minutes');
      await event(a, engineA, 'ask_cleared', '40 minutes');
      await event(a, detailA, 'team_log_line', '30 minutes', BODY.team_log_line, 0);
      await event(a, engineA, 'merge_lane', '25 minutes');
      await event(a, engineA, 'gate_receipt', '20 minutes');
      await event(a, engineA, 'merged', '15 minutes');
      await event(a, engineA, 'agent_started', '10 minutes');
      await event(a, engineA, 'agent_stopped', '5 minutes'); // no usage figure: it is the agents' and the stats' event, not the usage panel's
      await event(a, engineA, 'engine_heartbeat', '1 minute'); // a heartbeat is the status panel's: it ages no panel here
      expect(await asOfMsAgo('asks')).toBe(40);
      expect(await asOfMsAgo('log')).toBe(30);
      expect(await asOfMsAgo('lanes')).toBe(25);
      expect(await asOfMsAgo('gates')).toBe(20); // merge_lane (25) and gate_receipt (20)
      expect(await asOfMsAgo('agents')).toBe(5);
      expect(await asOfMsAgo('stats')).toBe(5); // started, stopped, merged and the gate
      expect(await asOfMsAgo('usage')).toBeNull();
    });

    it('the usage panel counts a stop or a tick only when it carried a figure, and an agent link always', async () => {
      await event(a, engineA, 'agent_stopped', '3 minutes', { ...BODY.agent_stopped, usage: { input: 1, output: 2, cache_read: 3, cache_write: 4 } });
      expect(await asOfMsAgo('usage')).toBe(3);
      await event(a, engineA, 'tick_ended', '2 minutes', { ...BODY.tick_ended, usage: { input: 9 } });
      expect(await asOfMsAgo('usage')).toBe(2);
      await event(a, engineA, 'tick_ended', '1 minute'); // no figure
      expect(await asOfMsAgo('usage')).toBe(2);
      await event(a, engineA, 'agent_linked', '30 seconds');
      expect(await asOfMsAgo('usage')).toBe(1); // 30 s rounds to a minute
    });

    it('is the cloud\'s receive time, not the time the runner stamped on the event', async () => {
      // Every event above carries a ts nine days old; the panels still read minutes ago.
      expect(await asOfMsAgo('agents')).toBeLessThan(10);
    });

    it('names the same kinds as the database\'s own panel map (engine_kind_panels)', async () => {
      for (const panel of PANELS) {
        const spec = ENGINE_PANEL_KINDS[panel];
        const fromDb: string[] = [];
        for (const kind of Object.keys(BODY)) {
          const panels = (await admin.query<{ p: string[] | null }>(`SELECT engine_kind_panels($1) AS p`, [kind])).rows[0]!.p ?? [];
          if (panels.includes(panel)) fromDb.push(kind);
        }
        const mine = [...spec.kinds, ...(spec.usageOnly ?? [])];
        // Every kind the database maps to the panel is read here, and every kind read without a body test is one the database maps to it.
        expect(fromDb.filter((k) => !mine.includes(k)), `${panel}: kinds the database maps that the read misses`).toEqual([]);
        expect(spec.kinds.filter((k) => !fromDb.includes(k)), `${panel}: kinds read that the database does not map`).toEqual([]);
        // The only kind read beyond the database's map is a tick with a figure, for the usage panel.
        expect(mine.filter((k) => !fromDb.includes(k)), panel).toEqual(panel === 'usage' ? ['tick_ended'] : []);
      }
    });
  });

  describe('tenant scoping of the panel stamp', () => {
    it('a second repo of the same account reads none of the first repo\'s events, and the first reads none of its', async () => {
      await event(a, engineSecond, 'merge_lane', '1 minute');
      await event(a, engineSecond, 'ask_raised', '2 minutes');
      expect(await asOfMsAgo('lanes', second)).toBe(1);
      expect(await asOfMsAgo('asks', second)).toBe(2);
      expect(await asOfMsAgo('agents', second)).toBeNull();
      expect(await asOfMsAgo('lanes')).toBe(25); // still the first repo's own
    });

    it('another account\'s repo reads nothing of this account\'s, and this account reads nothing of its events', async () => {
      await event(b, engineB, 'ask_raised', '90 seconds');
      expect(await asOfMsAgo('asks', b.repoId, b)).toBe(2); // 90 s rounds to 2 minutes
      expect(await asOfMsAgo('asks')).toBe(40);
      expect(await asOfMsAgo('log', b.repoId, b)).toBeNull();
    });

    it('the RLS-bypassing client with a foreign account id reads nothing, for either repo', async () => {
      for (const p of PANELS) {
        expect(await readEnginePanelAsOf(admin, b.accountId, a.repoId, p), `${p} of a's repo as b`).toBeNull();
        expect(await readEnginePanelAsOf(admin, a.accountId, b.repoId, p), `${p} of b's repo as a`).toBeNull();
      }
    });

    it('a tenant client of another account reads nothing through row security, even when it names the right account id for the repo', async () => {
      const asB = withTenant(appPool, b.accountId, b.userId, (c) => readEnginePanelAsOf(c, a.accountId, a.repoId, 'asks'));
      expect(await asB).toBeNull();
      expect(await withTenant(appPool, b.accountId, b.userId, (c) => readEnginePanelAsOf(c, b.accountId, a.repoId, 'asks'))).toBeNull();
      expect(await asA((c) => readEnginePanelAsOf(c, a.accountId, a.repoId, 'asks'))).not.toBeNull();
    });
  });

  describe('held events and the oldest detail seq in the freshness read', () => {
    const fresh = (repo = a.repoId, account = a) => asA((c) => readEngineRepoFreshness(c, repo, account.accountId));

    it('no held hole and no detail upload: zero and null', async () => {
      const f = await fresh();
      expect(f).toMatchObject({ held_events: 0, oldest_seq: 0 }); // the log line uploaded at seq 0 above
      expect((await asA((c) => readEngineRepoFreshness(c, second, a.accountId)))).toMatchObject({ held_events: 0, oldest_seq: null });
    });

    it('held_events is the sum of the held holes\' lengths and never part of missing_events; a real hole is the other way round', async () => {
      await gap(a, engineA, 10, 14, true); // 5
      await gap(a, engineA, 20, 20, true); // 1
      await gap(a, engineA, 30, 31, false); // 2, a real hole
      expect(await fresh()).toMatchObject({ held_events: 6, missing_events: 2 });
    });

    it('oldest_seq is the lowest seq of the repo\'s detail sessions: the engine session\'s lower seqs do not count, and an older upload lowers it', async () => {
      await event(a, detailA, 'team_log_line', '29 minutes', BODY.team_log_line, 40);
      await event(a, detailA, 'team_log_line', '28 minutes', BODY.team_log_line, 41);
      expect((await fresh())!.oldest_seq).toBe(0);
      await admin.query(`DELETE FROM engine_events WHERE session_id = $1 AND seq = 0`, [detailA]);
      expect((await fresh())!.oldest_seq).toBe(40);
      // Load older: a lower seq arrives in the detail session.
      await event(a, detailA, 'team_log_line', '27 minutes', BODY.team_log_line, 12);
      expect((await fresh())!.oldest_seq).toBe(12);
    });

    it('a second repo of the same account and another account read none of this repo\'s held holes or detail seqs', async () => {
      const detailSecond = await session(a, runnerA, second, 'detail');
      await event(a, detailSecond, 'team_log_line', '1 minute', BODY.team_log_line, 3);
      await gap(a, engineSecond, 2, 3, true);
      expect(await asA((c) => readEngineRepoFreshness(c, second, a.accountId))).toMatchObject({ held_events: 2, oldest_seq: 3 });
      expect(await fresh()).toMatchObject({ held_events: 6, oldest_seq: 12 });
      await gap(b, engineB, 0, 99, true);
      const detailB = await session(b, runnerB, b.repoId, 'detail');
      await event(b, detailB, 'team_log_line', '1 minute', BODY.team_log_line, 7);
      expect(await withTenant(appPool, b.accountId, b.userId, (c) => readEngineRepoFreshness(c, b.repoId, b.accountId))).toMatchObject({ held_events: 100, oldest_seq: 7 });
      expect(await fresh()).toMatchObject({ held_events: 6, oldest_seq: 12 });
    });

    it('the RLS-bypassing client with a foreign account id reads nothing; a tenant client of another account reads nothing', async () => {
      expect(await readEngineRepoFreshness(admin, a.repoId, b.accountId)).toBeNull();
      expect(await readEngineRepoFreshness(admin, b.repoId, a.accountId)).toBeNull();
      expect(await withTenant(appPool, b.accountId, b.userId, (c) => readEngineRepoFreshness(c, a.repoId, b.accountId))).toBeNull();
      expect(await withTenant(appPool, b.accountId, b.userId, (c) => readEngineRepoFreshness(c, a.repoId, a.accountId))).toBeNull();
    });
  });
});
