import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { setPendingHooks } from '../../src/pendingWork.js';
import { CHECK_PASS_BUDGET_MS, sweepSetupRequestChecks } from '../../src/setup-requests/checkSweep.js';
import { unavailableVercelEnvSource, type VercelEnvSource } from '../../src/setup-requests/checks.js';
import { CHECK_INTERVAL_SECONDS } from '../../src/setup-requests/copy.js';
import { SETUP_REQUEST_DUE_AFTER_SECONDS } from '@fx/db/src/setupRequestLister.js';
import { NotFoundError } from '../../src/tenancy/errors.js';
import { withTenant } from '../../src/tenancy/withTenant.js';
import {
  SetupRequestError,
  applyCheckOutcome,
  getSetupRequest,
  proposeSetupRequest,
  reopenSetupRequest,
  resolveSetupRequest,
  setupHoldFor,
  type ProposeSetupRequestInput,
  type SetupRequest,
} from '../../src/setup-requests/store.js';
import { FakeVercel } from '../support/vercelEnvFake.js';

/**
 * [pg] D#598 P8b: the check sweep, the application of a check's result and the re-open fold, against a real Postgres as the real roles: the
 * sweep runs on the runner login (app_user + agent_run_writer), the lister is the 0874 definer, every write is under the request's own tenant.
 * Covers P8b-L1 (through the sweep), C2 (the re-open fold), C4's passing-check half, and the "resumes within one check interval" half of
 * acceptance 23 against the strict Vercel listing fake. The Mark-done halves, the race tests (C1) and the API fields are P8b-2.
 */
const RUNNER_LOGIN = 'fx_setup_check_test';
const SECRET = 'sk_live_VALUE_THAT_MUST_NEVER_BE_KEPT';
const NAME = 'STRIPE_KEY';

describe('setup request check sweep [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let runner: Pool;
  let A: SeedRefs;
  let B: SeedRefs;
  const logs: string[] = [];
  const log = (line: string) => void logs.push(line);
  let markers: Map<string, number>;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    await admin.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RUNNER_LOGIN}') THEN
          CREATE ROLE ${RUNNER_LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        END IF;
      END $$`);
    await admin.query(`GRANT app_user, agent_run_writer TO ${RUNNER_LOGIN}`);
    const u = new URL(process.env.DATABASE_URL_APP_USER!);
    u.username = RUNNER_LOGIN;
    u.password = '';
    runner = createPool(u.toString());
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), runner.end()]);
  });
  beforeEach(async () => {
    // Earlier cases leave open requests behind; the sweep lists across accounts, so close them before each case.
    await admin.query(`UPDATE setup_requests SET state = 'withdrawn', resolution = 'withdrawn', resolved_by = created_by WHERE state = 'open'`);
    A = await seedAccount(admin, randomUUID());
    B = await seedAccount(admin, randomUUID());
    logs.length = 0;
    markers = new Map();
    setPendingHooks({
      store: {
        get: async (k) => markers.get(k) ?? null,
        set: async (k, v) => void markers.set(k, v),
        delete: async (k) => void markers.delete(k),
      },
    });
  });
  afterEach(() => setPendingHooks(null));

  const inTenant = <T>(t: SeedRefs, fn: (c: PoolClient) => Promise<T>): Promise<T> => withTenant(runner, t.accountId, t.userId, undefined, fn);
  const base = (t: SeedRefs, over: Partial<ProposeSetupRequestInput> = {}): ProposeSetupRequestInput => ({
    userId: t.userId, repoId: t.repoId, workItemId: t.workItemId, kind: 'env_var', target: 'cloud-staging', envName: NAME, reason: 'needed for the build', check: 'env_var_present', ...over,
  });
  const propose = (t: SeedRefs, over: Partial<ProposeSetupRequestInput> = {}): Promise<SetupRequest> => inTenant(t, (c) => proposeSetupRequest(c, base(t, over)));
  const read = (t: SeedRefs, id: string): Promise<SetupRequest> => inTenant(t, (c) => getSetupRequest(c, id));
  const hold = (t: SeedRefs): Promise<string | null> => inTenant(t, (c) => setupHoldFor(c, t.workItemId));
  /** The cron fires once a minute; the database clock is real, so "a minute later" is the check stamp moved back past the 45 second rule. */
  const ageCheck = (id: string, seconds = 61) => admin.query(`UPDATE setup_requests SET check_ran_at = now() - make_interval(secs => $2::integer) WHERE id = $1`, [id, seconds]);
  const advances = async (t: SeedRefs) =>
    (await admin.query<{ id: string; requested_by: string; principal_kind: string; state: string }>(
      `SELECT id, requested_by, principal_kind, state FROM run_action_requests WHERE account_id = $1 AND kind = 'advance_work_item' AND target_id = $2`, [t.accountId, t.workItemId])).rows;
  const sweep = (source: VercelEnvSource, over: { now?: () => number; announce?: (id: string) => void } = {}) =>
    sweepSetupRequestChecks({ pool: runner, envSource: source, log, ...(over.now ? { now: over.now } : {}), ...(over.announce ? { announceRunAction: over.announce } : {}) });

  it('a request with a check is listed, checked as its own tenant and left open with the fixed reason; the item stays held and no restart is filed', async () => {
    const vercel = new FakeVercel().connect(A.accountId).project('cloud-staging');
    const r = await propose(A);
    const clock = Date.parse('2026-10-18T10:00:00Z');
    const counts = await sweep(vercel.source(), { now: () => clock });
    expect(counts).toMatchObject({ listed: 1, passed: 0, notYet: 1, failed: 0, nextDueAt: clock + SETUP_REQUEST_DUE_AFTER_SECONDS * 1000 });
    const after = await read(A, r.id);
    expect(after).toMatchObject({ state: 'open', resolution: null, checkReason: 'env_var_missing' });
    expect(Math.abs(after.checkRanAt!.getTime() - Date.now())).toBeLessThan(10_000);
    expect(await hold(A)).toBe('setup_request_open');
    expect(await advances(A)).toEqual([]);
    expect(vercel.calls).toEqual([{ accountId: A.accountId, project: 'cloud-staging', query: 'target=&gitBranch=&source=' }]);
  });

  it('acceptance 23 (resumes within one check interval): the person sets the variable, the next minute\'s tick resumes the item by itself, once', async () => {
    const vercel = new FakeVercel().connect(A.accountId).project('cloud-staging');
    const r = await propose(A);
    const announced: string[] = [];
    const t0 = Date.parse('2026-10-18T10:00:00Z');
    const first = await sweep(vercel.source(), { now: () => t0, announce: (id) => void announced.push(id) });
    expect(first.notYet).toBe(1);
    // The same tick 10 seconds later (a second cron firing, a kick) does not ask the provider again: the request was just looked at.
    expect((await sweep(vercel.source(), { now: () => t0 + 10_000 })).listed).toBe(0);
    expect(vercel.calls).toHaveLength(1);
    // The person sets the variable 10 seconds after the first look; the next tick is the interval after the first one.
    vercel.setVar('cloud-staging', { key: NAME, value: SECRET, target: ['production', 'preview'] });
    const nextTick = first.nextDueAt!;
    expect(nextTick - t0).toBe(SETUP_REQUEST_DUE_AFTER_SECONDS * 1000);
    expect(nextTick - (t0 + 10_000)).toBeLessThanOrEqual(CHECK_INTERVAL_SECONDS * 1000);
    await ageCheck(r.id);
    const second = await sweep(vercel.source(), { now: () => nextTick, announce: (id) => void announced.push(id) });
    expect(second).toMatchObject({ listed: 1, passed: 1, notYet: 0, failed: 0 });
    const done = await read(A, r.id);
    expect(done).toMatchObject({ state: 'done', resolution: 'check_passed', resolvedBy: null, checkReason: 'env_var_missing' });
    expect(done.resolvedAt).not.toBeNull();
    expect(await hold(A)).toBeNull();
    const filed = await advances(A);
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({ requested_by: `session:${A.userId}`, principal_kind: 'session', state: 'accepted' });
    expect(announced).toEqual([filed[0]!.id]);
    // Nothing is left to do: the next tick lists nothing, asks nothing, files nothing.
    const third = await sweep(vercel.source(), { now: () => nextTick + 60_000 });
    expect(third).toMatchObject({ listed: 0, nextDueAt: null });
    expect(vercel.calls).toHaveLength(2);
    expect(await advances(A)).toHaveLength(1);
  });

  it('every reason, in turn: missing, then set for the wrong environment, then unreachable (never a pass), then set for production', async () => {
    const vercel = new FakeVercel().connect(A.accountId).project('cloud-staging');
    const r = await propose(A);
    const reasons: Array<string | null> = [];
    const step = async (): Promise<void> => {
      await ageCheck(r.id);
      await sweep(vercel.source());
      reasons.push((await read(A, r.id)).checkReason);
    };
    await sweep(vercel.source());
    reasons.push((await read(A, r.id)).checkReason);
    vercel.setVar('cloud-staging', { key: NAME, value: SECRET, target: ['preview'] });
    await step();
    vercel.failNext('http_500');
    await step();
    expect((await read(A, r.id)).state).toBe('open');
    vercel.setVar('cloud-staging', { key: NAME, value: SECRET, target: ['production'] });
    await step();
    expect(reasons).toEqual(['env_var_missing', 'env_var_wrong_target', 'check_unavailable', 'check_unavailable']);
    expect(await read(A, r.id)).toMatchObject({ state: 'done', resolution: 'check_passed' });
  });

  it('the production binding is "unavailable": the request stays open with check_unavailable and is never resumed by the sweep', async () => {
    const r = await propose(A);
    const counts = await sweep(unavailableVercelEnvSource);
    expect(counts).toMatchObject({ listed: 1, passed: 0, notYet: 1, nextDueAt: null });
    expect(await read(A, r.id)).toMatchObject({ state: 'open', checkReason: 'check_unavailable' });
    expect(await hold(A)).toBe('setup_request_open');
  });

  it('a request with no work item passes and closes, and files no restart', async () => {
    const vercel = new FakeVercel().connect(A.accountId).project('cloud-staging', [{ key: NAME, value: SECRET, target: ['production'] }]);
    const r = await propose(A, { workItemId: null });
    expect(await sweep(vercel.source())).toMatchObject({ passed: 1 });
    expect(await read(A, r.id)).toMatchObject({ state: 'done', resolution: 'check_passed' });
    expect((await admin.query(`SELECT 1 FROM run_action_requests WHERE account_id = $1 AND kind = 'advance_work_item'`, [A.accountId])).rowCount).toBe(0);
  });

  it('two accounts: each request is read, asked about and written under its own tenant; the one without a Vercel connection is unavailable, not a pass', async () => {
    const vercel = new FakeVercel().connect(A.accountId).project('cloud-staging', [{ key: NAME, value: SECRET, target: ['production'] }]);
    const ra = await propose(A);
    const rb = await propose(B);
    const counts = await sweep(vercel.source());
    expect(counts).toMatchObject({ listed: 2, passed: 1, notYet: 1 });
    expect(await read(A, ra.id)).toMatchObject({ state: 'done', resolution: 'check_passed' });
    expect(await read(B, rb.id)).toMatchObject({ state: 'open', checkReason: 'check_unavailable' });
    expect(vercel.calls.map((c) => c.accountId).sort()).toEqual([A.accountId, B.accountId].sort());
    // account B's tenant cannot see account A's request, and the other way round
    await expect(read(B, ra.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(await advances(A)).toHaveLength(1);
    expect(await advances(B)).toHaveLength(0);
  });

  it('undo: a request withdrawn before the tick is not listed and the provider is not asked; one withdrawn while the provider is being asked is not written', async () => {
    const vercel = new FakeVercel().connect(A.accountId).project('cloud-staging', [{ key: NAME, value: SECRET, target: ['production'] }]);
    const gone = await propose(A);
    await inTenant(A, (c) => resolveSetupRequest(c, { id: gone.id, userId: A.userId, to: 'withdrawn' }));
    expect(await sweep(vercel.source())).toMatchObject({ listed: 0, nextDueAt: null });
    expect(vercel.calls).toHaveLength(0);

    const racing = await propose(A, { target: 'second-project' });
    vercel.project('second-project', [{ key: NAME, value: SECRET, target: ['production'] }]);
    const real = vercel.source();
    const withdrawsWhileAsked: VercelEnvSource = {
      available: true,
      listEnvNames: async (input) => {
        await inTenant(A, (c) => resolveSetupRequest(c, { id: racing.id, userId: A.userId, to: 'withdrawn' }));
        return real.listEnvNames(input);
      },
    };
    expect(await sweep(withdrawsWhileAsked)).toMatchObject({ listed: 1, passed: 0, skipped: 1, failed: 0 });
    expect(await read(A, racing.id)).toMatchObject({ state: 'withdrawn', resolution: 'withdrawn', checkReason: null });
    expect(await advances(A)).toHaveLength(0);
  });

  it('a request marked done by a person while the provider is being asked is not touched either', async () => {
    const vercel = new FakeVercel().connect(A.accountId).project('cloud-staging', [{ key: NAME, value: SECRET, target: ['production'] }]);
    const r = await propose(A);
    const real = vercel.source();
    const source: VercelEnvSource = {
      available: true,
      listEnvNames: async (input) => {
        await inTenant(A, (c) => resolveSetupRequest(c, { id: r.id, userId: A.userId, to: 'done' }));
        return real.listEnvNames(input);
      },
    };
    expect(await sweep(source)).toMatchObject({ skipped: 1, passed: 0 });
    expect(await read(A, r.id)).toMatchObject({ state: 'done', resolution: 'marked_done' });
    expect(await advances(A)).toHaveLength(0);
  });

  it('a proposer who is no longer a member is not listed: the provider is not asked and nothing is written; leaving during the provider call is refused by the database, nothing half-done', async () => {
    const vercel = new FakeVercel().connect(A.accountId).project('cloud-staging', [{ key: NAME, value: SECRET, target: ['production'] }]).project('second', [{ key: NAME, value: SECRET, target: ['production'] }]);
    const gone = await propose(A);
    const racing = await propose(A, { target: 'second', workItemId: null });
    const spare = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [spare, `${spare}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner')`, [A.accountId, spare]);
    const real = vercel.source();
    const leavesWhileAsked: VercelEnvSource = {
      available: true,
      listEnvNames: async (input) => {
        await admin.query(`DELETE FROM account_members WHERE account_id = $1 AND user_id = $2`, [A.accountId, A.userId]);
        return real.listEnvNames(input);
      },
    };
    // Both are listed while the proposer is a member; the first provider call removes them, so both fail at their write...
    const counts = await sweep(leavesWhileAsked);
    expect(counts).toMatchObject({ listed: 2, passed: 0, failed: 2 });
    expect(logs.filter((l) => l.includes('"code":"writer_gone"')).length).toBe(2);
    expect(await advances(A)).toHaveLength(0);
    for (const id of [gone.id, racing.id]) expect((await admin.query(`SELECT state FROM setup_requests WHERE id = $1`, [id])).rows[0].state).toBe('open');
    // ...and from the next pass on neither is listed, and the provider is not asked.
    const before = vercel.calls.length;
    expect(await sweep(vercel.source())).toMatchObject({ listed: 0, failed: 0 });
    expect(vercel.calls.length).toBe(before);
  });

  it('starvation: 55 requests of an account whose proposer left do not stop another account\'s request from being checked on the first pass', async () => {
    const vercel = new FakeVercel().connect(A.accountId).connect(B.accountId).project('cloud-staging', [{ key: NAME, value: SECRET, target: ['production'] }]);
    for (let i = 0; i < 55; i++) await propose(A, { workItemId: null, target: `stuck-${i}` });
    const spare = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [spare, `${spare}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner')`, [A.accountId, spare]);
    await admin.query(`DELETE FROM account_members WHERE account_id = $1 AND user_id = $2`, [A.accountId, A.userId]);
    const rb = await propose(B);
    const counts = await sweep(vercel.source());
    expect(counts).toMatchObject({ listed: 1, passed: 1, failed: 0 });
    expect(await read(B, rb.id)).toMatchObject({ state: 'done', resolution: 'check_passed' });
  });

  it('one account with 60 due requests gets at most 10 places in a pass, and another account\'s request is checked in the same pass', async () => {
    const vercel = new FakeVercel().connect(A.accountId).connect(B.accountId).project('cloud-staging');
    for (let i = 0; i < 60; i++) {
      vercel.project(`proj-${i}`);
      await propose(A, { workItemId: null, target: `proj-${i}` });
    }
    const rb = await propose(B);
    const counts = await sweep(vercel.source());
    expect(counts).toMatchObject({ listed: 11, notYet: 11, failed: 0 });
    expect(vercel.calls.filter((c) => c.accountId === A.accountId)).toHaveLength(10);
    expect((await read(B, rb.id)).checkReason).toBe('env_var_missing');
  });

  it('the next minute\'s tick still runs: the marker is set from the start of the pass, so a slow list query does not push it past the next cron firing', async () => {
    const vercel = new FakeVercel().connect(A.accountId).project('cloud-staging');
    await propose(A);
    let t = Date.parse('2026-10-18T10:00:00Z');
    const start = t;
    // every reading of the clock advances it: the list query, the tenant reads and the provider call take 300 ms each
    const counts = await sweep(vercel.source(), { now: () => (t += 300) });
    expect(counts.nextDueAt).not.toBeNull();
    // the cron fires 60 s after it fired; the marker is at or before that moment
    expect(counts.nextDueAt!).toBeLessThanOrEqual(start + 60_000);
    expect(counts.nextDueAt! - start).toBeLessThanOrEqual(SETUP_REQUEST_DUE_AFTER_SECONDS * 1000 + 300);
  });

  it('a value the provider returns never reaches a row, a log line, a reply or the audit log', async () => {
    const vercel = new FakeVercel().connect(A.accountId).project('cloud-staging', [
      { key: NAME, value: SECRET, target: ['preview'], type: 'plain' },
      { key: 'OTHER', value: SECRET, target: ['production'], type: 'encrypted' },
    ]);
    const r = await propose(A);
    const counts = await sweep(vercel.source());
    vercel.setVar('cloud-staging', { key: NAME, value: SECRET, target: ['production'] });
    await ageCheck(r.id);
    const counts2 = await sweep(vercel.source());
    const dump = JSON.stringify([
      counts, counts2, logs,
      (await admin.query(`SELECT * FROM setup_requests WHERE account_id = $1`, [A.accountId])).rows,
      (await admin.query(`SELECT * FROM run_action_requests WHERE account_id = $1`, [A.accountId])).rows,
      (await admin.query(`SELECT * FROM audit_log WHERE account_id = $1`, [A.accountId])).rows,
    ]);
    expect(dump).not.toContain(SECRET);
  });

  it('a list that cannot be read is counted and logged by a fixed code, asks for the next tick, and does not throw', async () => {
    const broken = { query: vi.fn(async () => { throw Object.assign(new Error('boom with host db.internal'), { code: '57P01' }); }) } as unknown as Pool;
    const counts = await sweepSetupRequestChecks({ pool: broken, envSource: new FakeVercel().source(), log, now: () => 1_000_000 });
    expect(counts).toMatchObject({ listed: 0, failed: 1, nextDueAt: 1_000_000 + SETUP_REQUEST_DUE_AFTER_SECONDS * 1000 });
    expect(logs.join('\n')).toContain('"code":"57P01"');
    expect(logs.join('\n')).not.toContain('db.internal');
  });

  it('a pass stops starting checks after its budget and asks for the next tick', async () => {
    const vercel = new FakeVercel().connect(A.accountId).project('cloud-staging').project('p2');
    await propose(A);
    await propose(A, { target: 'p2' });
    let t = 0;
    const counts = await sweep(vercel.source(), { now: () => (t += CHECK_PASS_BUDGET_MS / 2 + 1) });
    expect(counts.listed).toBe(2);
    expect(counts.notYet).toBeLessThan(2);
    expect(counts.nextDueAt).not.toBeNull();
  });

  describe('applyCheckOutcome', () => {
    it('a check that no longer applies (the request is not open) writes nothing', async () => {
      const r = await propose(A);
      await inTenant(A, (c) => resolveSetupRequest(c, { id: r.id, userId: A.userId, to: 'done' }));
      expect(await inTenant(A, (c) => applyCheckOutcome(c, { id: r.id, outcome: { pass: true } }))).toEqual({ result: 'skipped' });
      expect(await advances(A)).toHaveLength(0);
      await expect(inTenant(A, (c) => applyCheckOutcome(c, { id: randomUUID(), outcome: { pass: true } }))).rejects.toBeInstanceOf(NotFoundError);
    });

    it('a pass files ONE restart however many times the same pass is applied and however the item is restarted by a person afterwards', async () => {
      const r = await propose(A);
      await inTenant(A, (c) => applyCheckOutcome(c, { id: r.id, outcome: { pass: true } }));
      await inTenant(A, (c) => applyCheckOutcome(c, { id: r.id, outcome: { pass: true } }));
      expect(await advances(A)).toHaveLength(1);
    });

    it('a pass whose restart cannot be filed (the proposer is now a plain member) rolls back the closing too; such a request is no longer listed', async () => {
      const vercel = new FakeVercel().connect(A.accountId).project('cloud-staging', [{ key: NAME, value: SECRET, target: ['production'] }]);
      const r = await propose(A);
      const spare = randomUUID();
      await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [spare, `${spare}@example.test`]);
      await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner')`, [A.accountId, spare]);
      await admin.query(`UPDATE account_members SET role = 'member' WHERE account_id = $1 AND user_id = $2`, [A.accountId, A.userId]);
      await expect(inTenant(A, (c) => applyCheckOutcome(c, { id: r.id, outcome: { pass: true } }))).rejects.toMatchObject({ code: '42501' });
      expect((await admin.query(`SELECT state, resolution FROM setup_requests WHERE id = $1`, [r.id])).rows[0]).toEqual({ state: 'open', resolution: null });
      expect(await sweep(vercel.source())).toMatchObject({ listed: 0, passed: 0 });
      expect(await advances(A)).toHaveLength(0);
    });
  });

  describe('marker', () => {
    const key = 'pending:setup-request-check';
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

    it('creating a request with a check marks the sweep pending; one without a check does not', async () => {
      await propose(A, { kind: 'app_not_installed', target: 'acme/web', envName: null, check: null });
      await settle();
      expect(markers.has(key)).toBe(false);
      await propose(A);
      await settle();
      expect(markers.has(key)).toBe(true);
    });
  });

  describe('re-open (C2)', () => {
    const open = async (t: SeedRefs): Promise<Array<{ id: string; check_reason: string | null }>> =>
      (await admin.query(`SELECT id, check_reason FROM setup_requests WHERE account_id = $1 AND state = 'open'`, [t.accountId])).rows;
    const markDone = (t: SeedRefs, id: string) => inTenant(t, (c) => resolveSetupRequest(c, { id, userId: t.userId, to: 'done' }));

    it('a done request goes back to open with the check\'s reason, and the sweep marker is set', async () => {
      const r = await propose(A);
      await markDone(A, r.id);
      markers.clear();
      const out = await inTenant(A, (c) => reopenSetupRequest(c, { id: r.id, reason: 'env_var_missing' }));
      expect(out.folded).toBe(false);
      expect(out.request).toMatchObject({ id: r.id, state: 'open', resolution: null, resolvedBy: null, resolvedAt: null, checkReason: 'env_var_missing' });
      expect(await hold(A)).toBe('setup_request_open');
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(markers.has('pending:setup-request-check')).toBe(true);
      // asking again for one that is open only refreshes its stamp
      const again = await inTenant(A, (c) => reopenSetupRequest(c, { id: r.id, reason: 'check_unavailable' }));
      expect(again).toMatchObject({ folded: false, request: { id: r.id, state: 'open', checkReason: 'check_unavailable' } });
    });

    it('done, then a new open request for the same step, then a failed check on the old one: it folds into the new one, no second open row', async () => {
      const old = await propose(A);
      await markDone(A, old.id);
      const fresh = await propose(A);
      expect(fresh.id).not.toBe(old.id);
      const out = await inTenant(A, (c) => reopenSetupRequest(c, { id: old.id, reason: 'env_var_wrong_target' }));
      expect(out.folded).toBe(true);
      expect(out.request.id).toBe(fresh.id);
      expect(await open(A)).toEqual([{ id: fresh.id, check_reason: 'env_var_wrong_target' }]);
      expect(await read(A, old.id)).toMatchObject({ state: 'done', resolution: 'marked_done', checkReason: null });
    });

    it('a twin that appears between the look and the write (the unique index) is folded into on the retry', async () => {
      const old = await propose(A);
      await markDone(A, old.id);
      let twinId = '';
      await inTenant(A, async (client) => {
        let injected = false;
        const spy = new Proxy(client, {
          get(target, prop, receiver) {
            if (prop !== 'query') return Reflect.get(target, prop, receiver);
            return async (...args: unknown[]) => {
              if (!injected && typeof args[0] === 'string' && args[0].startsWith('SAVEPOINT')) {
                injected = true;
                twinId = randomUUID();
                await admin.query(
                  `INSERT INTO setup_requests (id, account_id, repo_id, work_item_id, origin, kind, target, env_name, reason, check_kind, created_by)
                   VALUES ($1, $2, $3, $4, 'agent', 'env_var', 'cloud-staging', $5, 'asked again', 'env_var_present', $6)`,
                  [twinId, A.accountId, A.repoId, A.workItemId, NAME, A.userId],
                );
              }
              return (target.query as (...a: unknown[]) => unknown)(...args);
            };
          },
        }) as PoolClient;
        const out = await reopenSetupRequest(spy, { id: old.id, reason: 'env_var_missing' });
        expect(out).toMatchObject({ folded: true, request: { id: twinId, checkReason: 'env_var_missing' } });
      });
      expect(await open(A)).toEqual([{ id: twinId, check_reason: 'env_var_missing' }]);
      expect((await read(A, old.id)).state).toBe('done');
    });

    it('a request for a different item, or a different target, is not a twin', async () => {
      const old = await propose(A);
      await markDone(A, old.id);
      const other = await propose(A, { target: 'another-project' });
      const out = await inTenant(A, (c) => reopenSetupRequest(c, { id: old.id, reason: 'env_var_missing' }));
      expect(out.folded).toBe(false);
      expect((await open(A)).map((o) => o.id).sort()).toEqual([old.id, other.id].sort());
    });

    it('refuses what cannot be put back: a withdrawn request, one with no check, an unknown id', async () => {
      const w = await propose(A);
      await inTenant(A, (c) => resolveSetupRequest(c, { id: w.id, userId: A.userId, to: 'withdrawn' }));
      await expect(inTenant(A, (c) => reopenSetupRequest(c, { id: w.id, reason: 'env_var_missing' }))).rejects.toMatchObject({ code: 'not_open' });
      const noCheck = await propose(A, { kind: 'app_not_installed', target: 'acme/web', envName: null, check: null });
      await markDone(A, noCheck.id);
      await expect(inTenant(A, (c) => reopenSetupRequest(c, { id: noCheck.id, reason: 'env_var_missing' }))).rejects.toBeInstanceOf(SetupRequestError);
      await expect(inTenant(A, (c) => reopenSetupRequest(c, { id: randomUUID(), reason: 'env_var_missing' }))).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
