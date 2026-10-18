import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { setPendingHooks } from '../../src/pendingWork.js';
import { markSetupRequestDone } from '../../src/setup-requests/markDone.js';
import { sweepSetupRequestChecks } from '../../src/setup-requests/checkSweep.js';
import { unavailableVercelEnvSource, type VercelEnvSource } from '../../src/setup-requests/checks.js';
import { checkIntervalFor, statusSentence } from '../../src/setup-requests/copy.js';
import { withTenant } from '../../src/tenancy/withTenant.js';
import { SetupRequestError, getSetupRequest, proposeSetupRequest, setupHoldFor, type ProposeSetupRequestInput, type SetupRequest } from '../../src/setup-requests/store.js';
import { createRecordingRunActionSignal } from '../../src/runActions/signal.js';
import { FakeVercel } from '../support/vercelEnvFake.js';

/**
 * [pg] D#598 P8b-2: Mark done with its immediate check, against a real Postgres as the real roles (the person's session on app_user, the
 * sweep on the runner login). Covers sentences 3 and 4 end to end, acceptance 23's Mark-done halves ("mark done resumes at once", "a failed
 * check after Mark done re-pauses with the check's reason"), C4 (one `advance_work_item` per Mark done, a second press is a no-op), the
 * restart key per (request, open generation), and the C1 unique-violation race.
 */
const RUNNER_LOGIN = 'fx_mark_done_test';
const NAME = 'STRIPE_KEY';
const SECRET = 'sk_live_VALUE_THAT_MUST_NEVER_BE_KEPT';

describe('setup request Mark done [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUser: Pool;
  let runner: Pool;
  let A: SeedRefs;
  const logs: string[] = [];
  const log = (line: string) => void logs.push(line);

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUser = createPool(process.env.DATABASE_URL_APP_USER!);
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
    await Promise.all([adminPool.end(), appUser.end(), runner.end()]);
  });
  beforeEach(async () => {
    // The sweep lists across accounts: close what earlier cases left open.
    await admin.query(`UPDATE setup_requests SET state = 'withdrawn', resolution = 'withdrawn', resolved_by = created_by WHERE state = 'open'`);
    A = await seedAccount(admin, randomUUID());
    logs.length = 0;
    const markers = new Map<string, number>();
    setPendingHooks({ store: { get: async (k) => markers.get(k) ?? null, set: async (k, v) => void markers.set(k, v), delete: async (k) => void markers.delete(k) } });
  });
  afterEach(() => setPendingHooks(null));

  const inTenant = <T>(t: SeedRefs, fn: (c: PoolClient) => Promise<T>): Promise<T> => withTenant(appUser, t.accountId, t.userId, undefined, fn);
  const base = (t: SeedRefs, over: Partial<ProposeSetupRequestInput> = {}): ProposeSetupRequestInput => ({
    userId: t.userId, repoId: t.repoId, workItemId: t.workItemId, kind: 'env_var', target: 'cloud-staging', envName: NAME, reason: 'needed for the build', check: 'env_var_present', ...over,
  });
  const propose = (t: SeedRefs, over: Partial<ProposeSetupRequestInput> = {}): Promise<SetupRequest> => inTenant(t, (c) => proposeSetupRequest(c, base(t, over)));
  const read = (t: SeedRefs, id: string): Promise<SetupRequest> => inTenant(t, (c) => getSetupRequest(c, id));
  const hold = (t: SeedRefs): Promise<string | null> => inTenant(t, (c) => setupHoldFor(c, t.workItemId));
  const restarts = async (t: SeedRefs) =>
    (await admin.query<{ id: string; state: string; idempotency_key: string; requested_by: string }>(
      `SELECT id, state, idempotency_key, requested_by FROM run_action_requests WHERE account_id = $1 AND kind = 'advance_work_item' AND target_id = $2 ORDER BY created_at, id`,
      [t.accountId, t.workItemId])).rows;
  /** The run-action sweep performed the restart: it is no longer live, so a later one is a new row rather than the same one in flight. */
  const finishRestarts = (t: SeedRefs) => admin.query(`UPDATE run_action_requests SET state = 'done', finished_at = now() WHERE account_id = $1 AND target_id = $2 AND state IN ('accepted', 'claimed')`, [t.accountId, t.workItemId]);
  const sentence = (r: SetupRequest, available = true): string | null => statusSentence(r, { checksAvailable: available });
  const press = (source: VercelEnvSource, id: string, t: SeedRefs = A, signal = createRecordingRunActionSignal()) =>
    markSetupRequestDone({ pool: appUser, envSource: source, signal, log }, { accountId: t.accountId, userId: t.userId, id });
  const withVar = (target: string[] = ['production']) => new FakeVercel().connect(A.accountId).project('cloud-staging', [{ key: NAME, value: SECRET, target }]);
  const without = () => new FakeVercel().connect(A.accountId).project('cloud-staging');

  it('acceptance 23 (mark done resumes at once): the person presses it, the variable is there, the item is restarted ONCE and nothing pauses it', async () => {
    const vercel = withVar();
    const r = await propose(A);
    expect(await hold(A)).toBe('setup_request_open');
    const signal = createRecordingRunActionSignal();
    const out = await press(vercel.source(), r.id, A, signal);
    expect(out).toMatchObject({ changed: true, check: 'passed', foldedInto: null, request: { id: r.id, state: 'done', resolution: 'marked_done', resolvedBy: A.userId } });
    expect(await hold(A)).toBeNull();
    const filed = await restarts(A);
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({ state: 'accepted', requested_by: `session:${A.userId}` });
    expect(signal.sent).toEqual([{ actionId: filed[0]!.id, accountId: A.accountId, kind: 'advance_work_item' }]);
    expect(vercel.calls).toHaveLength(1);
    // The check was answered: no "Checking now." any more, and nothing else to say about a closed request.
    const after = await read(A, r.id);
    expect(after.checkRanAt!.getTime()).toBeGreaterThan(after.resolvedAt!.getTime());
    expect(sentence(after)).toBeNull();
    expect(after.repausedAt).toBeNull();
  });

  it('C4: a second press is a no-op: no second restart, no second signal, the provider is not asked again, the answer is the request unchanged', async () => {
    const vercel = withVar();
    const r = await propose(A);
    const signal = createRecordingRunActionSignal();
    const first = await press(vercel.source(), r.id, A, signal);
    const second = await press(vercel.source(), r.id, A, signal);
    expect(second).toMatchObject({ changed: false, restart: null, check: 'none' });
    expect(second.request.resolvedAt).toEqual(first.request.resolvedAt);
    expect(await restarts(A)).toHaveLength(1);
    expect(signal.sent).toHaveLength(1);
    expect(vercel.calls).toHaveLength(1);
  });

  it('C4: two presses at once (two connections) change the request once: one restart, one check', async () => {
    const vercel = withVar();
    const r = await propose(A);
    const signal = createRecordingRunActionSignal();
    const outs = await Promise.all([press(vercel.source(), r.id, A, signal), press(vercel.source(), r.id, A, signal)]);
    expect(outs.filter((o) => o.changed)).toHaveLength(1);
    expect(await restarts(A)).toHaveLength(1);
    expect(signal.sent).toHaveLength(1);
    expect(vercel.calls).toHaveLength(1);
  });

  it('acceptance 23 (a failed check after Mark done re-pauses with the check\'s reason): sentence 4, the item is held again, the reason is the check\'s own', async () => {
    const vercel = without();
    const r = await propose(A);
    const out = await press(vercel.source(), r.id);
    expect(out).toMatchObject({ changed: true, check: 'not_yet', foldedInto: null });
    expect(out.request).toMatchObject({ id: r.id, state: 'open', resolution: null, resolvedBy: null, resolvedAt: null, checkReason: 'env_var_missing' });
    expect(out.request.repausedAt).not.toBeNull();
    expect(sentence(out.request)).toBe(`We checked and it isn't done yet: ${NAME} isn't set on cloud-staging yet. The item is paused again.`);
    expect(await hold(A)).toBe('setup_request_open');
    // The restart was filed with the closing; the hold refuses it (worker/test/setupHold.pg.test.ts), so the item stays paused.
    expect(await restarts(A)).toHaveLength(1);

    // Every other reason is read from the check, in its words.
    await finishRestarts(A);
    vercel.setVar('cloud-staging', { key: NAME, value: SECRET, target: ['preview'] });
    const again = await press(vercel.source(), r.id);
    expect(again.request.checkReason).toBe('env_var_wrong_target');
    expect(sentence(again.request)).toBe(`We checked and it isn't done yet: ${NAME} is set on cloud-staging, but not for production. The item is paused again.`);
  });

  it('sentence 3 ("Checking now.") reads from the row while the provider is being asked, and stops once it has answered', async () => {
    const vercel = withVar();
    const r = await propose(A);
    const seen: Array<string | null> = [];
    const watching: VercelEnvSource = {
      available: true,
      async listEnvNames(input) {
        seen.push(sentence(await read(A, r.id)));
        return vercel.source().listEnvNames(input);
      },
    };
    await press(watching, r.id);
    expect(seen).toEqual(['Checking now.']);
    expect(sentence(await read(A, r.id))).toBeNull();
  });

  it('"Checking now." is not believed forever: a check that never answered (its caller died) stops reading as running', async () => {
    const r = await propose(A);
    await press(unavailableVercelEnvSource, r.id);
    const done = await read(A, r.id);
    // With a source bound, a closed request whose check never answered reads as running only inside the window.
    expect(statusSentence(done, { checksAvailable: true, now: done.resolvedAt!.getTime() + 60_000 })).toBe('Checking now.');
    expect(statusSentence(done, { checksAvailable: true, now: done.resolvedAt!.getTime() + 121_000 })).toBeNull();
    expect(statusSentence(done, { checksAvailable: false, now: done.resolvedAt!.getTime() + 1_000 })).toBeNull();
  });

  it('a provider that cannot be asked never re-pauses: the person\'s word stands (the same words as a kind with no check), the stamp moves', async () => {
    const vercel = withVar();
    const r = await propose(A);
    vercel.failNext('http_500');
    const out = await press(vercel.source(), r.id);
    expect(out).toMatchObject({ changed: true, check: 'unreachable', request: { state: 'done', resolution: 'marked_done' } });
    expect(await hold(A)).toBeNull();
    expect(sentence(out.request)).toBeNull();
    expect(out.request.repausedAt).toBeNull();
    expect(await restarts(A)).toHaveLength(1);
  });

  it('with no credential source bound (production today) Mark done resumes with no check, and the provider is never asked', async () => {
    const r = await propose(A);
    const out = await press(unavailableVercelEnvSource, r.id);
    expect(out).toMatchObject({ check: 'none', request: { state: 'done' } });
    expect(await hold(A)).toBeNull();
    expect(await restarts(A)).toHaveLength(1);
    // The words agree with what happened: before the press it said it cannot check this one.
    expect(statusSentence({ ...r }, { checksAvailable: false })).toBe("We can't check this one for you. Press Mark done when it's finished.");
    expect(checkIntervalFor(r, { checksAvailable: false })).toBeNull();
    expect(checkIntervalFor(r, { checksAvailable: true })).toBe(60);
  });

  it('a request with no check and a request with no work item: closed, checked by nothing; the first restarts its item, the second files nothing', async () => {
    const vercel = withVar();
    const noCheck = await propose(A, { kind: 'app_not_installed', target: 'acme/web', envName: null, check: null });
    expect(await press(vercel.source(), noCheck.id)).toMatchObject({ check: 'none', request: { state: 'done' } });
    expect(await restarts(A)).toHaveLength(1);
    await finishRestarts(A);
    const noItem = await propose(A, { workItemId: null });
    expect(await press(vercel.source(), noItem.id)).toMatchObject({ check: 'passed', restart: null });
    expect(await restarts(A)).toHaveLength(1);
    expect(vercel.calls).toHaveLength(1);
  });

  it('a withdrawn request cannot be marked done (named error), an unknown id is not found, and a member of the account is refused by the database', async () => {
    const w = await propose(A);
    await inTenant(A, async (c) => void (await c.query(`UPDATE setup_requests SET state = 'withdrawn', resolution = 'withdrawn', resolved_by = $2 WHERE id = $1`, [w.id, A.userId])));
    await expect(press(withVar().source(), w.id)).rejects.toMatchObject({ code: 'not_open' });
    await expect(press(withVar().source(), randomUUID())).rejects.toMatchObject({ name: 'NotFoundError' });
    const open = await propose(A);
    const member = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [member, `${member}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [A.accountId, member]);
    await expect(markSetupRequestDone({ pool: appUser, envSource: withVar().source(), log }, { accountId: A.accountId, userId: member, id: open.id })).rejects.toMatchObject({ code: '42501' });
    expect((await read(A, open.id)).state).toBe('open');
    expect(await restarts(A)).toHaveLength(0);
  });

  describe('the restart key is per (request, open generation)', () => {
    it('Mark done twice in ONE generation files one restart (even when the first is performed in between); a reopen starts a new generation and files a new one', async () => {
      const vercel = without();
      const r = await propose(A);
      const first = await press(vercel.source(), r.id);
      expect(first.check).toBe('not_yet');
      const [k1] = await restarts(A);
      expect(k1!.idempotency_key).toMatch(new RegExp(`^setup_request_restart:${r.id}:\\d+$`));

      // Second generation: the variable is set, the person presses again. The first restart has been performed (refused by the hold).
      await finishRestarts(A);
      vercel.setVar('cloud-staging', { key: NAME, value: SECRET, target: ['production'] });
      const second = await press(vercel.source(), r.id);
      expect(second).toMatchObject({ changed: true, check: 'passed' });
      const filed = await restarts(A);
      expect(filed).toHaveLength(2);
      expect(filed[1]!.idempotency_key).not.toBe(k1!.idempotency_key);
      expect(filed[1]!.state).toBe('accepted');

      // Pressing the same generation again, or applying it again, files nothing new.
      await finishRestarts(A);
      await press(vercel.source(), r.id);
      expect(await restarts(A)).toHaveLength(2);
    });

    it('a reopen followed by a passing CHECK (the sweep) files a new restart too, and the same pass applied again does not', async () => {
      const vercel = without();
      const r = await propose(A);
      await press(vercel.source(), r.id); // closed, restart #1, checked: missing, put back
      await finishRestarts(A);
      vercel.setVar('cloud-staging', { key: NAME, value: SECRET, target: ['production'] });
      await admin.query(`UPDATE setup_requests SET check_ran_at = now() - interval '61 seconds' WHERE id = $1`, [r.id]);
      const counts = await sweepSetupRequestChecks({ pool: runner, envSource: vercel.source(), log });
      expect(counts).toMatchObject({ listed: 1, passed: 1 });
      const filed = await restarts(A);
      expect(filed).toHaveLength(2);
      expect(new Set(filed.map((f) => f.idempotency_key)).size).toBe(2);
      expect(await hold(A)).toBeNull();
      expect((await read(A, r.id)).resolution).toBe('check_passed');
    });

    it('while the first restart is still waiting to be performed, a later generation does not queue a second run (the live one is the answer)', async () => {
      const vercel = without();
      const r = await propose(A);
      await press(vercel.source(), r.id);
      vercel.setVar('cloud-staging', { key: NAME, value: SECRET, target: ['production'] });
      const second = await press(vercel.source(), r.id);
      expect(second.restart).toMatchObject({ replayed: true });
      expect(await restarts(A)).toHaveLength(1);
    });
  });

  describe('re-pause folds into a newer request for the same step (C2 through Mark done)', () => {
    it('the same step is asked again while the check runs: the older request stays done, the newer one is the one paused, with the check\'s reason', async () => {
      const vercel = without();
      const r = await propose(A);
      let twinId = '';
      const asking: VercelEnvSource = {
        available: true,
        async listEnvNames(input) {
          // The pressed request is already closed here, so the same step can be asked for again.
          twinId = (await propose(A)).id;
          return vercel.source().listEnvNames(input);
        },
      };
      const out = await press(asking, r.id);
      expect(out.check).toBe('not_yet');
      expect(out.request).toMatchObject({ id: r.id, state: 'done', resolution: 'marked_done' });
      expect(out.foldedInto).toMatchObject({ id: twinId, state: 'open', checkReason: 'env_var_missing' });
      expect(out.foldedInto!.repausedAt).not.toBeNull();
      expect(sentence(out.foldedInto!)).toContain("The item is paused again.");
      const open = (await admin.query(`SELECT id FROM setup_requests WHERE account_id = $1 AND state = 'open'`, [A.accountId])).rows;
      expect(open).toEqual([{ id: twinId }]);
    });
  });

  describe('a failure writing the check\'s answer', () => {
    it('is logged by a fixed code and leaves the person\'s Mark done standing: the request is done with its restart, never half-changed', async () => {
      const vercel = without();
      const r = await propose(A);
      const closing: VercelEnvSource = {
        available: true,
        async listEnvNames(input) {
          // The account is closed while the provider is being asked: the write of the answer cannot be made under its tenant.
          await admin.query(`UPDATE accounts SET deleted_at = now() WHERE id = $1`, [A.accountId]);
          return vercel.source().listEnvNames(input);
        },
      };
      const out = await press(closing, r.id);
      expect(out.check).toBe('failed');
      await admin.query(`UPDATE accounts SET deleted_at = NULL WHERE id = $1`, [A.accountId]);
      expect(await read(A, r.id)).toMatchObject({ state: 'done', resolution: 'marked_done' });
      expect(await restarts(A)).toHaveLength(1);
      const lines = logs.map((l) => JSON.parse(l) as { event: string; setup_request_id: string; code: string });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ event: 'setup_request_mark_done.check_write_failed', setup_request_id: r.id });
      expect(lines[0]!.code).toMatch(/^[A-Za-z0-9_]+$/);
    });
  });

  describe('a value never reaches a row, a log line or the answer', () => {
    it('the provider\'s value is not kept anywhere Mark done writes', async () => {
      const vercel = withVar();
      const r = await propose(A);
      const out = await press(vercel.source(), r.id);
      const everything = JSON.stringify([out, (await admin.query(`SELECT * FROM setup_requests WHERE id = $1`, [r.id])).rows, (await admin.query(`SELECT * FROM audit_log WHERE account_id = $1`, [A.accountId])).rows, logs]);
      expect(everything).not.toContain(SECRET);
    });
  });

  describe('C1: a unique violation on the open index is the named conflict, never a driver error (the race of two creates)', () => {
    it('a twin committed between the look and the write: the insert hits the unique index (23505) and is answered "already_open"', async () => {
      const first = await propose(A);
      await inTenant(A, async (c) => void (await c.query(`UPDATE setup_requests SET state = 'withdrawn', resolution = 'withdrawn', resolved_by = $2 WHERE id = $1`, [first.id, A.userId])));
      const outcome = await inTenant(A, async (client) => {
        let injected = false;
        const spy = new Proxy(client, {
          get(target, prop, receiver) {
            if (prop !== 'query') return Reflect.get(target, prop, receiver);
            return async (...args: unknown[]) => {
              if (!injected && typeof args[0] === 'string' && args[0].includes('INSERT INTO setup_requests')) {
                injected = true;
                // The other writer wins: its row is committed before ours is written.
                await admin.query(
                  `INSERT INTO setup_requests (account_id, repo_id, work_item_id, origin, kind, target, env_name, reason, check_kind, created_by)
                   VALUES ($1, $2, $3, 'agent', 'env_var', 'cloud-staging', $4, 'the other writer', 'env_var_present', $5)`,
                  [A.accountId, A.repoId, A.workItemId, NAME, A.userId],
                );
              }
              return (target.query as (...a: unknown[]) => unknown)(...args);
            };
          },
        }) as PoolClient;
        return proposeSetupRequest(spy, base(A)).then(() => 'created', (e: unknown) => e);
      });
      expect(outcome).toBeInstanceOf(SetupRequestError);
      expect(outcome).toMatchObject({ code: 'already_open' });
      expect((await admin.query(`SELECT count(*)::int AS n FROM setup_requests WHERE account_id = $1 AND state = 'open'`, [A.accountId])).rows[0]!.n).toBe(1);
    });

    it('two creates at once on two connections: exactly one wins, the other is "already_open", one open row', async () => {
      for (let round = 0; round < 6; round += 1) {
        const t = await seedAccount(admin, randomUUID());
        const results = await Promise.all([0, 1].map(() => inTenant(t, (c) => proposeSetupRequest(c, base(t))).then((r) => ({ ok: r.id }), (e: unknown) => ({ err: e }))));
        const won = results.filter((r) => 'ok' in r);
        const lost = results.filter((r) => 'err' in r) as Array<{ err: unknown }>;
        expect(won).toHaveLength(1);
        expect(lost).toHaveLength(1);
        expect(lost[0]!.err).toBeInstanceOf(SetupRequestError);
        expect(lost[0]!.err).toMatchObject({ code: 'already_open' });
        expect((await admin.query(`SELECT count(*)::int AS n FROM setup_requests WHERE account_id = $1`, [t.accountId])).rows[0]!.n).toBe(1);
      }
    });
  });
});
