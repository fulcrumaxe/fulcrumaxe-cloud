import { generateKeyPairSync, randomInt, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { signMachineJob, type MachineJob } from '@fulcrumaxe/runner-protocol';
import { createPool } from '@fx/db/src/pool.js';
import { nextGhInstallationId } from '@fx/db/test/helpers/seed.js';
import { insertRunner } from '@fx/db/test/helpers/runnerFixtures.js';
import { withTenant } from '../src/tenancy/withTenant.js';
import { readEngineRepos } from '../src/engine/panels.js';
import { readRepoSessionFacts, REPO_EVENT_QUOTA, SESSION_EVENT_QUOTA } from '../src/engine/sessionFacts.js';

/**
 * [pg] D#845 ON-14b: the session, setup and quota facts on the engine repos read, against the real schema with the real roles and row security forced. Each state is built from rows the real writers produce
 * (a setup row, a runner sandbox listing, signed session jobs, session and repo counters, the halt marker) and read back through the same call the route makes.
 */
describe('engine repo session facts [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  const keys = generateKeyPairSync('ed25519');
  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appPool.end();
  });

  interface Rig { accountId: string; ownerId: string; memberId: string; repoId: string; ghRepoId: number; runnerId: string; installationId: string }
  const uid = async (): Promise<string> => {
    const id = randomUUID();
    await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [id, `${id}@example.test`]);
    return id;
  };
  async function addRepo(a: Pick<Rig, 'accountId' | 'installationId'>, name: string): Promise<{ repoId: string; ghRepoId: number }> {
    const repoId = randomUUID();
    const ghRepoId = randomInt(1, 2_000_000_000);
    await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, $4, 'team', 'acme', $5)`, [repoId, a.accountId, a.installationId, ghRepoId, name]);
    await admin.query('INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)', [a.accountId, repoId]);
    return { repoId, ghRepoId };
  }
  /** A fresh account with an owner, a member, one ticked repo and one machine (not yet placed). */
  async function rig(): Promise<Rig> {
    const accountId = randomUUID();
    const ownerId = await uid();
    const memberId = await uid();
    await admin.query('INSERT INTO accounts (id) VALUES ($1)', [accountId]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member')`, [accountId, ownerId, memberId]);
    const installationId = randomUUID();
    await admin.query(`INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3, 'team')`, [installationId, accountId, nextGhInstallationId()]);
    const { repoId, ghRepoId } = await addRepo({ accountId, installationId }, 'widgets');
    const runnerId = await insertRunner(admin, accountId, ownerId);
    return { accountId, ownerId, memberId, repoId, ghRepoId, runnerId, installationId };
  }
  const place = (r: Rig, repoId = r.repoId, runnerId = r.runnerId) => admin.query(`INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'person')`, [repoId, r.accountId, runnerId]);
  const name = (r: Rig, runnerId: string, n: string) => admin.query('INSERT INTO runner_settings (runner_id, account_id, name) VALUES ($1, $2, $3)', [runnerId, r.accountId, n]);
  const setup = (r: Rig, phase: string, o: { state?: string; sub?: string | null; code?: string | null; ago?: number; repoId?: string } = {}) =>
    admin.query(
      `INSERT INTO project_setups (account_id, repo_id, kind, phase, sub_step, state, failure_code, failure_at, created_by, created_at) VALUES ($1, $2, 'existing', $3, $4, $5, $6, CASE WHEN $6::text IS NULL THEN NULL ELSE now() END, $7, now() - make_interval(mins => $8))`,
      [r.accountId, o.repoId ?? r.repoId, phase, o.sub ?? null, o.state ?? 'started', o.code ?? null, r.ownerId, o.ago ?? 0],
    );
  const sandbox = (r: Rig, state: string, o: { ghRepoId?: number; runnerId?: string; usedAgoMin?: number } = {}) =>
    admin.query(
      `INSERT INTO runner_sandboxes (runner_id, slot, account_id, name, state, created_at, last_used_at, disk_bytes, snapshot_count) VALUES ($1, $2, $3, $4, $5, now() - interval '3 hours', now() - make_interval(mins => $6), 1000, 1)`,
      [o.runnerId ?? r.runnerId, (o.ghRepoId ?? r.ghRepoId) % 150, r.accountId, `fx-engine-${o.ghRepoId ?? r.ghRepoId}`, state, o.usedAgoMin ?? 5],
    );
  /** A session job as the definers would have written it, signed for real. */
  async function job(r: Rig, kind: 'engine_session_start' | 'engine_session_stop', o: { reason?: string; mode?: string; agoMin: number; repoId?: string; ghRepoId?: number }): Promise<void> {
    const id = randomUUID();
    const issued = new Date(Date.now() - o.agoMin * 60_000 - 60_000);
    const args = kind === 'engine_session_stop' ? { reason: o.reason ?? 'person', operate_epoch: 1 } : { at_sha: 'e'.repeat(40), resume: false, operate_epoch: 1 };
    const signed = signMachineJob({ v: 1, job_id: id, runner_id: r.runnerId, repo_gh_id: o.ghRepoId ?? r.ghRepoId, requires_engine: 'any', issued_at: issued.toISOString(), expires_at: new Date(issued.getTime() + 25 * 60_000).toISOString(), kind, args } as MachineJob, 'job-key-1', keys.privateKey);
    await admin.query(
      `INSERT INTO machine_jobs (id, account_id, runner_id, repo_id, kind, job, state, issued_at, expires_at, delivered_at, ended_at, last_step, start_mode)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'done', $7, $8, $7, $9, $10, $11)`,
      [id, r.accountId, r.runnerId, o.repoId ?? r.repoId, kind, JSON.stringify(signed), issued, new Date(issued.getTime() + 25 * 60_000), new Date(Date.now() - o.agoMin * 60_000), kind === 'engine_session_start' ? 'done' : 'session_stop', kind === 'engine_session_start' ? (o.mode ?? 'created') : null],
    );
  }
  /** A session of the repo heard `heardAgoS` seconds ago, with the day's counter (`day` is a SQL date expression: today by default). */
  async function session(r: Rig, o: { heardAgoS?: number; count?: number; day?: string; kind?: 'engine' | 'bridge' | 'detail'; repoId?: string; runnerId?: string; createdAgoMin?: number } = {}): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO engine_sessions (id, account_id, runner_id, repo_id, engine_instance_id, engine_version, first_event_at, last_event_at, last_heard_at, quota_day, quota_count, session_kind, created_at)
       VALUES ($1, $2, $3, $4, $5, '1.2.3', now(), now(), now() - make_interval(secs => $6), ${o.day ?? "(now() AT TIME ZONE 'utc')::date"}, $7, $8, now() - make_interval(mins => $9))`,
      [id, r.accountId, o.runnerId ?? r.runnerId, o.repoId ?? r.repoId, randomUUID(), o.heardAgoS ?? 5, o.count ?? 0, o.kind ?? 'engine', o.createdAgoMin ?? 0],
    );
    return id;
  }
  const repoQuota = (r: Rig, count: number, day = "(now() AT TIME ZONE 'utc')::date", repoId = r.repoId) =>
    admin.query(`INSERT INTO engine_repo_quota (account_id, repo_id, quota_day, quota_count) VALUES ($1, $2, ${day}, $3)`, [r.accountId, repoId, count]);
  const halt = (r: Rig) => admin.query(`INSERT INTO engine_repo_controls (account_id, repo_id, halted_at, halt_action_id, halt_epoch) VALUES ($1, $2, now(), $3, 1)`, [r.accountId, r.repoId, randomUUID()]);
  const read = async (r: Rig, who: 'owner' | 'member' = 'owner', repoId = r.repoId) =>
    (await withTenant(appPool, r.accountId, who === 'owner' ? r.ownerId : r.memberId, (c) => readEngineRepos(c, r.accountId))).find((i) => i.repo_id === repoId)!;

  describe('session state', () => {
    it('never: no session, no sandbox, no setup, no machine, and a quota with nothing used', async () => {
      const r = await rig();
      const row = await read(r);
      expect(row.session).toEqual({ state: 'never', last_start_mode: null, last_start_at: null, stopped_reason: null, state_at: null });
      expect(row.setup).toEqual({ status: 'none', phase: null, sub_step: null, state: null, failure_code: null });
      expect(row.machine_name).toBeNull();
      expect(row.quota).toMatchObject({ state: 'ok', session_used: 0, repo_used: 0, session_limit: 5000, repo_limit: 20000 });
    });

    it('starting while the sandbox is being created, and while it runs but nothing has been heard yet', async () => {
      const r = await rig();
      await sandbox(r, 'creating');
      expect((await read(r)).session.state).toBe('starting');
      await admin.query('DELETE FROM runner_sandboxes WHERE account_id = $1', [r.accountId]);
      await sandbox(r, 'running');
      expect((await read(r)).session.state).toBe('starting');
    });

    it('running when the sandbox runs and the session was heard within 3 minutes; stale after, and the same with no sandbox row', async () => {
      const r = await rig();
      await sandbox(r, 'running');
      await session(r, { heardAgoS: 60 });
      expect((await read(r)).session.state).toBe('running');
      const stale = await rig();
      await sandbox(stale, 'running');
      await session(stale, { heardAgoS: 3600 });
      expect((await read(stale)).session.state).toBe('stale');
      const bare = await rig();
      await session(bare, { heardAgoS: 3600 });
      expect((await read(bare)).session.state).toBe('stale');
      const live = await rig();
      await session(live, { heardAgoS: 10 });
      expect((await read(live)).session.state).toBe('running');
    });

    it('stopped for a stopped or snapshotted sandbox, with the stop reason and the time; stale liveness does not hide it', async () => {
      for (const state of ['stopped', 'snapshotted']) {
        const r = await rig();
        await sandbox(r, state, { usedAgoMin: 12 });
        await session(r, { heardAgoS: 7200 });
        await job(r, 'engine_session_start', { agoMin: 60, mode: 'created' });
        await job(r, 'engine_session_stop', { agoMin: 12, reason: 'operate_off' });
        const s = (await read(r)).session;
        expect(s, state).toMatchObject({ state: 'stopped', stopped_reason: 'operate_off', last_start_mode: 'created' });
        expect(Math.abs(Date.parse(s.state_at!) - (Date.now() - 12 * 60_000))).toBeLessThan(30_000);
      }
    });

    it('every stop reason reads as itself', async () => {
      for (const reason of ['person', 'halt', 'move', 'remove', 'operate_off', 'plan']) {
        const r = await rig();
        await sandbox(r, 'stopped');
        await job(r, 'engine_session_stop', { agoMin: 3, reason });
        expect((await read(r)).session.stopped_reason, reason).toBe(reason);
      }
    });

    it('a stop older than the newest start is not the session\'s stop, and a running sandbox carries no stop reason', async () => {
      const r = await rig();
      await sandbox(r, 'running');
      await session(r, { heardAgoS: 5 });
      await job(r, 'engine_session_stop', { agoMin: 30, reason: 'person' });
      await job(r, 'engine_session_start', { agoMin: 10, mode: 'resumed' });
      expect((await read(r)).session).toMatchObject({ state: 'running', stopped_reason: null, last_start_mode: 'resumed' });
      const stopped = await rig();
      await sandbox(stopped, 'stopped');
      await job(stopped, 'engine_session_stop', { agoMin: 30, reason: 'person' });
      await job(stopped, 'engine_session_start', { agoMin: 10, mode: 'fresh' });
      expect((await read(stopped)).session).toMatchObject({ state: 'stopped', stopped_reason: null, last_start_mode: 'fresh' });
    });

    it('reads each start mode, with the start\'s end time', async () => {
      for (const mode of ['created', 'resumed', 'fresh']) {
        const r = await rig();
        await sandbox(r, 'running');
        await session(r);
        await job(r, 'engine_session_start', { agoMin: 20, mode });
        const s = (await read(r)).session;
        expect(s.last_start_mode, mode).toBe(mode);
        expect(Math.abs(Date.parse(s.last_start_at!) - (Date.now() - 20 * 60_000))).toBeLessThan(30_000);
      }
    });

    it('halted wins over stopped, running and stale; runner_removed wins over halted', async () => {
      const r = await rig();
      await sandbox(r, 'running');
      await session(r, { heardAgoS: 5 });
      await halt(r);
      expect((await read(r)).session.state).toBe('halted');
      const stale = await rig();
      await session(stale, { heardAgoS: 9999 });
      await halt(stale);
      expect((await read(stale)).session.state).toBe('halted');
      await admin.query('UPDATE runners SET revoked_at = now() WHERE id = $1', [stale.runnerId]);
      expect((await read(stale)).session.state).toBe('runner_removed');
    });

    it('an error sandbox says nothing of the engine: liveness decides', async () => {
      const r = await rig();
      await sandbox(r, 'error');
      expect((await read(r)).session.state).toBe('never');
      await session(r, { heardAgoS: 5 });
      expect((await read(r)).session.state).toBe('running');
    });

    it('a repo with two sandbox listings reads the newest', async () => {
      const r = await rig();
      const other = await insertRunner(admin, r.accountId, r.ownerId);
      await sandbox(r, 'stopped', { usedAgoMin: 500 });
      await sandbox(r, 'creating', { runnerId: other, usedAgoMin: 1 });
      expect((await read(r)).session.state).toBe('starting');
    });

    it('a placed repo reads the placed runner\'s listing even when a leftover sandbox on the old machine changed later', async () => {
      const r = await rig();
      const old = await insertRunner(admin, r.accountId, r.ownerId);
      await place(r);
      await sandbox(r, 'stopped', { usedAgoMin: 500 });
      await sandbox(r, 'running', { runnerId: old, usedAgoMin: 1 });
      expect((await read(r)).session.state).toBe('stopped');
    });
  });

  describe('setup and machine name', () => {
    it('open while a setup is under way or failed, done once installed, none when removed or absent', async () => {
      const open = await rig();
      await setup(open, 'install', { sub: 'deps', state: 'started' });
      expect((await read(open)).setup).toEqual({ status: 'open', phase: 'install', sub_step: 'deps', state: 'started', failure_code: null });
      const failed = await rig();
      await setup(failed, 'await_merge', { state: 'failed', code: 'pr_closed' });
      expect((await read(failed)).setup).toMatchObject({ status: 'open', phase: 'await_merge', state: 'failed', failure_code: 'pr_closed' });
      const done = await rig();
      await setup(done, 'done', { state: 'ok' });
      expect((await read(done)).setup).toMatchObject({ status: 'done', phase: 'done', state: 'ok' });
      const removed = await rig();
      await setup(removed, 'done', { state: 'ok', ago: 60 });
      await setup(removed, 'removed', { state: 'ok', ago: 5 });
      expect((await read(removed)).setup.status).toBe('none');
      const reopened = await rig();
      await setup(reopened, 'done', { state: 'ok', ago: 60 });
      await setup(reopened, 'survey', { state: 'started', ago: 1 });
      expect((await read(reopened)).setup).toMatchObject({ status: 'open', phase: 'survey' });
    });

    it('names the placed machine; an unnamed one gets the registrant\'s label; an unplaced repo falls back to its newest session\'s runner', async () => {
      const named = await rig();
      await place(named);
      await name(named, named.runnerId, 'Studio laptop');
      expect((await read(named)).machine_name).toBe('Studio laptop');
      const unnamed = await rig();
      await place(unnamed);
      expect((await read(unnamed)).machine_name).toMatch(/^Unnamed runner \(/);
      const unplaced = await rig();
      expect((await read(unplaced)).machine_name).toBeNull();
      await name(unplaced, unplaced.runnerId, 'Old desk');
      await session(unplaced);
      expect((await read(unplaced)).machine_name).toBe('Old desk');
    });

    it('never + setup done reads the machine it is placed on, before any session exists', async () => {
      const r = await rig();
      await setup(r, 'done', { state: 'ok' });
      await place(r);
      await name(r, r.runnerId, 'Rack 2');
      const row = await read(r);
      expect(row).toMatchObject({ machine_name: 'Rack 2', setup: { status: 'done' }, session: { state: 'never' } });
    });
  });

  describe('quota', () => {
    it('session boundary: 4999 ok, 5000 and 5001 full', async () => {
      for (const [count, state] of [[SESSION_EVENT_QUOTA - 1, 'ok'], [SESSION_EVENT_QUOTA, 'session_full'], [SESSION_EVENT_QUOTA + 1, 'session_full']] as const) {
        const r = await rig();
        await session(r, { count });
        expect((await read(r)).quota, String(count)).toMatchObject({ state, session_used: count, session_limit: 5000 });
      }
    });

    it('repo boundary: 19999 ok, 20000 and 20001 full, and the repo state outranks a full session', async () => {
      for (const [count, state] of [[REPO_EVENT_QUOTA - 1, 'ok'], [REPO_EVENT_QUOTA, 'repo_full'], [REPO_EVENT_QUOTA + 1, 'repo_full']] as const) {
        const r = await rig();
        await session(r, { count: 10 });
        await repoQuota(r, count);
        expect((await read(r)).quota, String(count)).toMatchObject({ state, repo_used: count, repo_limit: 20000 });
      }
      const both = await rig();
      await session(both, { count: 5000 });
      await repoQuota(both, 20000);
      expect((await read(both)).quota.state).toBe('repo_full');
    });

    it('across the UTC reset: counters stamped yesterday read 0 and ok; the reset time is the next 00:00 UTC', async () => {
      const r = await rig();
      await session(r, { count: 5000, day: "(now() AT TIME ZONE 'utc')::date - 1" });
      await repoQuota(r, 20000, "(now() AT TIME ZONE 'utc')::date - 1");
      const q = (await read(r)).quota;
      expect(q).toMatchObject({ state: 'ok', session_used: 0, repo_used: 0 });
      const dbNext = (await admin.query<{ t: Date }>(`SELECT (((now() AT TIME ZONE 'utc')::date + 1)::timestamp AT TIME ZONE 'utc') AS t`)).rows[0]!.t;
      expect(q.resets_at).toBe(dbNext.toISOString());
      expect(q.resets_at).toMatch(/T00:00:00\.000Z$/);
      expect(Date.parse(q.resets_at)).toBeGreaterThan(Date.now());
      expect(Date.parse(q.resets_at) - Date.now()).toBeLessThanOrEqual(86_400_000);
      // The same counters stamped today are full.
      const today = await rig();
      await session(today, { count: 5000 });
      await repoQuota(today, 20000);
      expect((await read(today)).quota).toMatchObject({ state: 'repo_full', session_used: 5000, repo_used: 20000 });
    });

    it('reads the newest session of each kind: an older full one does not count, and the highest of the kinds is the binding count', async () => {
      const r = await rig();
      await session(r, { count: 5000, createdAgoMin: 90 });
      await session(r, { count: 40, createdAgoMin: 30 });
      await session(r, { count: 900, kind: 'bridge', createdAgoMin: 0 });
      await session(r, { count: 7, kind: 'detail', createdAgoMin: 0 });
      expect((await read(r)).quota).toMatchObject({ state: 'ok', session_used: 900 });
    });

    it('a full bridge session or a full detail session pauses uploads: session_full, and repo_full still outranks it', async () => {
      const bridge = await rig();
      await session(bridge, { count: 40 });
      await session(bridge, { count: 5000, kind: 'bridge' });
      expect((await read(bridge)).quota).toMatchObject({ state: 'session_full', session_used: 5000 });
      const detail = await rig();
      await session(detail, { count: 40 });
      await session(detail, { count: 5000, kind: 'detail' });
      expect((await read(detail)).quota).toMatchObject({ state: 'session_full', session_used: 5000 });
      const yesterday = await rig();
      await session(yesterday, { count: 5000, kind: 'detail', day: "(now() AT TIME ZONE 'utc')::date - 1" });
      expect((await read(yesterday)).quota).toMatchObject({ state: 'ok', session_used: 0 });
      const both = await rig();
      await session(both, { count: 5000, kind: 'detail' });
      await repoQuota(both, 20000);
      expect((await read(both)).quota.state).toBe('repo_full');
    });

    it('the limits are the ingest definer\'s: the newest migration that defines it caps 5000 a session and 20000 a repo', () => {
      const dir = join(__dirname, '../../db/migrations');
      const newest = readdirSync(dir).filter((f) => f.endsWith('.sql') && readFileSync(join(dir, f), 'utf8').includes('CREATE OR REPLACE FUNCTION') && readFileSync(join(dir, f), 'utf8').includes('GREATEST(0, 5000 - v_count)')).sort().pop()!;
      const sql = readFileSync(join(dir, newest), 'utf8');
      expect(sql).toContain(`GREATEST(0, ${SESSION_EVENT_QUOTA} - v_count)`);
      expect(sql).toContain(`GREATEST(0, ${REPO_EVENT_QUOTA} - v_rcount)`);
      expect(sql).toContain(`v_rcount >= ${REPO_EVENT_QUOTA}`);
    });
  });

  describe('tenancy', () => {
    it('a second repo of the same account never borrows its sibling\'s facts', async () => {
      const r = await rig();
      const second = await addRepo(r, 'gadgets');
      await setup(r, 'done', { state: 'ok' });
      await sandbox(r, 'stopped');
      await job(r, 'engine_session_stop', { agoMin: 4, reason: 'person' });
      await session(r, { count: 5000 });
      await repoQuota(r, 20000);
      await place(r);
      await name(r, r.runnerId, 'First box');
      const sibling = await read(r, 'owner', second.repoId);
      expect(sibling.setup.status).toBe('none');
      expect(sibling.session).toEqual({ state: 'never', last_start_mode: null, last_start_at: null, stopped_reason: null, state_at: null });
      expect(sibling.quota).toMatchObject({ state: 'ok', session_used: 0, repo_used: 0 });
      expect(sibling.machine_name).toBeNull();
      const first = await read(r);
      expect(first).toMatchObject({ machine_name: 'First box', setup: { status: 'done' }, session: { state: 'stopped', stopped_reason: 'person' }, quota: { state: 'repo_full' } });
    });

    it('another account\'s sessions are never visible: its repo is not listed, and its id read as this account reads nothing', async () => {
      const mine = await rig();
      const theirs = await rig();
      await setup(theirs, 'done', { state: 'ok' });
      await sandbox(theirs, 'stopped');
      await job(theirs, 'engine_session_stop', { agoMin: 4, reason: 'halt' });
      await session(theirs, { count: 5000 });
      await repoQuota(theirs, 20000);
      await place(theirs);
      await name(theirs, theirs.runnerId, 'Their box');
      // The list of my account does not carry their repo.
      const list = await withTenant(appPool, mine.accountId, mine.ownerId, (c) => readEngineRepos(c, mine.accountId));
      expect(list.map((i) => i.repo_id)).toEqual([mine.repoId]);
      // Asked with their repo id under my account id, as the RLS-bypassing admin client, every fact is empty.
      const [asMine] = await readRepoSessionFacts(admin, [{ accountId: mine.accountId, repoId: theirs.repoId, liveness: 'never', halted: false, runnerName: null }], 'A team member');
      expect(asMine).toMatchObject({ machine_name: null, setup: { status: 'none' }, session: { state: 'never', last_start_mode: null, stopped_reason: null }, quota: { state: 'ok', session_used: 0, repo_used: 0 } });
      // And as the app role under my tenant, the same ask answers the same.
      const [viaRls] = await withTenant(appPool, mine.accountId, mine.ownerId, (c) => readRepoSessionFacts(c, [{ accountId: theirs.accountId, repoId: theirs.repoId, liveness: 'never', halted: false, runnerName: null }], 'A team member'));
      expect(viaRls).toMatchObject({ machine_name: null, setup: { status: 'none' }, session: { state: 'never' }, quota: { state: 'ok', repo_used: 0 } });
      // Their own read still sees them.
      expect((await read(theirs)).quota.state).toBe('repo_full');
    });

    it('an owner and a member read the same facts', async () => {
      const r = await rig();
      await setup(r, 'done', { state: 'ok' });
      await sandbox(r, 'stopped');
      await job(r, 'engine_session_stop', { agoMin: 2, reason: 'person' });
      await session(r, { count: 77 });
      await place(r);
      await name(r, r.runnerId, 'Shared box');
      const owner = await read(r, 'owner');
      const member = await read(r, 'member');
      expect(member.machine_name).toBe('Shared box');
      expect({ setup: member.setup, session: member.session, quota: member.quota, machine_name: member.machine_name }).toEqual({ setup: owner.setup, session: owner.session, quota: owner.quota, machine_name: owner.machine_name });
    });

    it('a user of another account reads nothing of this one', async () => {
      const mine = await rig();
      const other = await rig();
      await session(mine, { count: 5000 });
      const rows = await withTenant(appPool, other.accountId, other.ownerId, (c) => readEngineRepos(c, other.accountId));
      expect(rows.some((i) => i.repo_id === mine.repoId)).toBe(false);
    });
  });
});
