import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { clearRepoPairing } from '../../src/repos/pairing.js';
import {
  markPlaneParityDue,
  sweepPlaneParity,
  PARITY_CONCURRENCY,
  PARITY_MAX_PER_TICK,
  PARITY_CHECK_MS,
  PARITY_WRITE_MARGIN_MS,
  type ParityCompute,
  type ParityJob,
  type ParityOutcome,
  type ParityResult,
} from '../../src/repos/planeParityChecks.js';
import { listSetupRequests, resolveSetupRequest, type SetupRequest } from '../../src/setup-requests/store.js';
import { withTenant } from '../../src/tenancy/withTenant.js';

/**
 * [pg] D#598 P1d-3: the due mark, the claim, the result row and the derived `parity_drift` request, against a real Postgres as the real roles (the sweep
 * runs on the run-writer login; every write is under the account's own tenant). Every time here is read from the database's own clock with intervals, so
 * nothing depends on the host's time zone or on when the suite runs.
 */
const RUNNER_LOGIN = 'fx_parity_sweep_test';
const SHA = (c: string): string => c.repeat(40);
const OWNER = 'acme-priv';

describe('plane parity checks [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let runner: Pool;
  let appUser: Pool;
  let A: SeedRefs;
  let B: SeedRefs;
  let n = 0;

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
    appUser = createPool(process.env.DATABASE_URL_APP_USER!);
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), runner.end(), appUser.end()]);
  });
  beforeEach(async () => {
    // The sweep lists across accounts: park every earlier case's rows and close its requests first.
    await admin.query(`UPDATE plane_parity_checks SET due_at = NULL`);
    await admin.query(`UPDATE setup_requests SET state = 'done', resolution = 'condition_cleared' WHERE state = 'open' AND origin = 'derived'`);
    A = await seedAccount(admin, randomUUID());
    B = await seedAccount(admin, randomUUID());
  });

  const inTenant = <T>(t: SeedRefs, fn: (c: PoolClient) => Promise<T>): Promise<T> => withTenant(runner, t.accountId, t.userId, undefined, fn);
  /** Pairs the account's repo with a public repo that has its own row in the account (so the installation can be found). Returns the public full name. */
  async function pair(t: SeedRefs, o: { publicRow?: boolean; globs?: string[] } = {}): Promise<{ priv: string; pub: string }> {
    const id = ++n;
    const priv = `priv${id}`;
    const pub = `pub${id}`;
    await admin.query(`UPDATE repos SET gh_owner = $2, gh_name = $3 WHERE id = $1`, [t.repoId, OWNER, priv]);
    if (o.publicRow !== false) {
      await admin.query(`INSERT INTO repos (account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, 'team', 'acme-pub', $4)`, [t.accountId, t.installationId, 100 + id, pub]);
    }
    await admin.query(`INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs) VALUES ($1, $2, $3, $4)`, [t.repoId, t.accountId, `acme-pub/${pub}`, o.globs ?? ['.autonomous-team/**']]);
    return { priv: `${OWNER}/${priv}`, pub: `acme-pub/${pub}` };
  }
  const mark = (t: SeedRefs, fullName: string, repoId: string | null = t.repoId) => inTenant(t, (c) => markPlaneParityDue(c, { accountId: t.accountId, repoId, fullName }));
  const row = async (t: SeedRefs) =>
    (await admin.query<{ secs: string | null; last_result: string | null; streak: number; public_sha: string | null }>(
      `SELECT extract(epoch FROM (due_at - now())) AS secs, last_result, unavailable_streak AS streak, public_sha FROM plane_parity_checks WHERE repo_id = $1`, [t.repoId])).rows[0];
  const makeDue = (t: SeedRefs) => admin.query(`UPDATE plane_parity_checks SET due_at = now() - interval '1 second' WHERE repo_id = $1`, [t.repoId]);
  const requests = async (t: SeedRefs): Promise<SetupRequest[]> => (await inTenant(t, (c) => listSetupRequests(c, { repoId: t.repoId, state: 'all' }))).requests.filter((r) => r.kind === 'parity_drift');
  const outcome = (result: ParityResult, over: Partial<ParityOutcome> = {}): ParityOutcome => ({
    result, privateSha: SHA('a'), publicSha: SHA('b'), syncSha: SHA('c'), paths: [], pathCount: 0, limitSide: null, ...over,
  });
  const sweep = (compute: ParityCompute) => sweepPlaneParity({ pool: runner, compute, log: () => undefined });
  const returning = (o: ParityOutcome): ParityCompute => async () => o;

  describe('the due mark', () => {
    it('a push marks the pairing due about 60 seconds ahead, whichever of the two repos was pushed; five pushes are one row and keep the earliest time', async () => {
      const p = await pair(A);
      expect(await mark(A, p.priv)).toBe(1);
      const first = Number((await row(A))!.secs);
      expect(first).toBeGreaterThan(50);
      expect(first).toBeLessThanOrEqual(60);
      await admin.query(`UPDATE plane_parity_checks SET due_at = now() + interval '10 seconds' WHERE repo_id = $1`, [A.repoId]);
      for (const name of [p.pub, p.pub.toUpperCase(), p.priv, p.pub, p.priv]) expect(await mark(A, name, name === p.priv ? A.repoId : null)).toBe(1);
      expect(Number((await row(A))!.secs)).toBeLessThanOrEqual(10);
      expect((await admin.query(`SELECT count(*)::int AS n FROM plane_parity_checks WHERE repo_id = $1`, [A.repoId])).rows[0].n).toBe(1);
    });

    it('marks nothing for a repo with no pairing, or for a public repo paired only in another account', async () => {
      const p = await pair(A);
      expect(await mark(B, 'acme-pub/unrelated', B.repoId)).toBe(0);
      expect(await mark(B, p.pub, null)).toBe(0);
      expect((await admin.query(`SELECT count(*)::int AS n FROM plane_parity_checks WHERE account_id = $1`, [B.accountId])).rows[0].n).toBe(0);
    });

    it('a push resets the back-off streak and pulls a later due time forward', async () => {
      const p = await pair(A);
      await mark(A, p.priv);
      await admin.query(`UPDATE plane_parity_checks SET due_at = now() + interval '30 minutes', unavailable_streak = 3 WHERE repo_id = $1`, [A.repoId]);
      await mark(A, p.pub, null);
      const r = (await row(A))!;
      expect(r.streak).toBe(0);
      expect(Number(r.secs)).toBeLessThanOrEqual(60);
    });
  });

  describe('the sweep', () => {
    it('five pushes lead to exactly one check; a second tick runs none; the row holds the result and no longer falls due', async () => {
      const p = await pair(A);
      for (let i = 0; i < 5; i++) await mark(A, p.pub, null);
      await makeDue(A);
      const calls: ParityJob[] = [];
      const compute: ParityCompute = async (job) => (calls.push(job), outcome('in_parity', { syncSha: SHA('b') }));
      const counts = await sweep(compute);
      expect(calls.map((j) => [j.repoId, j.privateRepo, j.publicRepo, j.publicRepoId !== null])).toEqual([[A.repoId, { owner: OWNER, name: p.priv.split('/')[1] }, { owner: 'acme-pub', name: p.pub.split('/')[1] }, true]]);
      expect(counts).toMatchObject({ listed: 1, checked: 1, failed: 0 });
      expect(await sweep(compute)).toMatchObject({ listed: 0, checked: 0 });
      expect(calls).toHaveLength(1);
      const r = (await row(A))!;
      expect([r.secs, r.last_result, r.public_sha]).toEqual([null, 'in_parity', SHA('b')]);
    });

    it('a row that is not yet due is listed but not run, and its time is the next tick asked for', async () => {
      const p = await pair(A);
      await mark(A, p.pub, null);
      let ran = 0;
      const clock = 1_000_000;
      const counts = await sweepPlaneParity({ pool: runner, compute: async () => (ran++, outcome('lag')), now: () => clock, log: () => undefined });
      expect(ran).toBe(0);
      expect(counts).toMatchObject({ listed: 1, checked: 0 });
      expect(counts.nextDueAt).toBeGreaterThan(Date.now());
    });

    it('a pairing whose public repo the account has no row for gets no outbound call from the platform: the compute is told (publicRepoId null)', async () => {
      const p = await pair(A, { publicRow: false });
      await mark(A, p.pub, null);
      await makeDue(A);
      let seen: ParityJob | undefined;
      await sweep(async (job) => ((seen = job), outcome('unavailable')));
      expect(seen!.publicRepoId).toBeNull();
    });

    it('runs at most 20 checks a tick and at most 4 at a time, and the rest wait for the next tick', async () => {
      const accounts: SeedRefs[] = [];
      for (let i = 0; i < PARITY_MAX_PER_TICK + 3; i++) {
        const t = await seedAccount(admin, randomUUID());
        const p = await pair(t);
        await mark(t, p.pub, null);
        await makeDue(t);
        accounts.push(t);
      }
      let running = 0;
      let peak = 0;
      let total = 0;
      const counts = await sweep(async () => {
        peak = Math.max(peak, ++running);
        total++;
        await new Promise((r) => setTimeout(r, 5));
        running--;
        return outcome('lag');
      });
      expect([total, counts.checked]).toEqual([PARITY_MAX_PER_TICK, PARITY_MAX_PER_TICK]);
      expect(peak).toBeLessThanOrEqual(PARITY_CONCURRENCY);
      expect(peak).toBeGreaterThan(1);
      expect(counts.nextDueAt).not.toBeNull();
      expect(await sweep(returning(outcome('lag')))).toMatchObject({ checked: 3 });
    });

    it('with nothing marked, a sweep lists nothing and never calls the check', async () => {
      await pair(A);
      let ran = 0;
      expect(await sweep(async () => (ran++, outcome('lag')))).toMatchObject({ listed: 0, checked: 0, nextDueAt: null });
      expect(ran).toBe(0);
    });

    it('with one deadline for the whole tick, no check starts once a check and the write of its result no longer fit before it', async () => {
      const p = await pair(A);
      await mark(A, p.pub, null);
      await makeDue(A);
      let ran = 0;
      const clock = 5_000_000;
      const compute: ParityCompute = async () => (ran++, outcome('lag'));
      const room = PARITY_CHECK_MS + PARITY_WRITE_MARGIN_MS;
      const late = await sweepPlaneParity({ pool: runner, compute, now: () => clock, deadlineAt: clock + room - 1, log: () => undefined });
      expect(ran).toBe(0);
      expect(late).toMatchObject({ listed: 1, checked: 0 });
      expect(late.nextDueAt).not.toBeNull();
      expect(await row(A)).toMatchObject({ last_result: null });
      const ok = await sweepPlaneParity({ pool: runner, compute, now: () => clock, deadlineAt: clock + room, log: () => undefined });
      expect([ran, ok.checked]).toEqual([1, 1]);
    });

    it('a push that lands while a check runs keeps its own due time: the result is written but the row stays due', async () => {
      const p = await pair(A);
      await mark(A, p.pub, null);
      await makeDue(A);
      const counts = await sweep(async () => {
        await mark(A, p.pub, null);
        return outcome('lag');
      });
      const r = (await row(A))!;
      expect(r.last_result).toBe('lag');
      expect(r.secs).not.toBeNull();
      expect(Number(r.secs)).toBeGreaterThan(0);
      expect(Number(r.secs)).toBeLessThanOrEqual(60);
      expect(counts.nextDueAt).not.toBeNull();
      expect(counts.nextDueAt! - Date.now()).toBeLessThanOrEqual(61_000);
    });

    it('a check that throws is recorded as unavailable, not lost', async () => {
      const p = await pair(A);
      await mark(A, p.pub, null);
      await makeDue(A);
      await sweep(async () => {
        throw new Error('https://api.example.test/secret-looking-path');
      });
      expect(await row(A)).toMatchObject({ last_result: 'unavailable', streak: 1 });
    });
  });

  describe('what each result does to the request', () => {
    const run = async (t: SeedRefs, o: ParityOutcome): Promise<void> => {
      await makeDue(t);
      await sweep(returning(o));
    };
    const due = async (t: SeedRefs, p: { pub: string }) => {
      await mark(t, p.pub, null);
    };

    it('lag with no drift raises nothing; drift raises exactly one request (N1: target, words, path, sha prefix); the same facts again change no row', async () => {
      const p = await pair(A);
      await due(A, p);
      await run(A, outcome('lag'));
      expect(await requests(A)).toEqual([]);
      await due(A, p);
      await run(A, outcome('drift', { paths: ['src/a.ts', 'src/b.ts'], pathCount: 2 }));
      const [r] = await requests(A);
      expect(await requests(A)).toHaveLength(1);
      expect(r).toMatchObject({ origin: 'derived', state: 'open', target: p.pub, workItemId: null });
      expect(r!.reason).toBe(`Private main of ${p.priv} differs from public main of ${p.pub} outside the overlay paths, compared at public commit ${'c'.repeat(7)}. 2 paths differ: src/a.ts, src/b.ts. Port the change to a public pull request, or undo it on private main.`);
      const before = (await admin.query(`SELECT * FROM setup_requests WHERE id = $1`, [r!.id])).rows[0];
      await due(A, p);
      await run(A, outcome('drift', { paths: ['src/a.ts', 'src/b.ts'], pathCount: 2 }));
      expect((await admin.query(`SELECT * FROM setup_requests WHERE id = $1`, [r!.id])).rows[0]).toEqual(before);
      expect((await requests(A)).map((x) => x.id)).toEqual([r!.id]);
    });

    it('new facts refresh the words of the one request; removing the change closes it as condition_cleared', async () => {
      const p = await pair(A);
      await due(A, p);
      await run(A, outcome('drift', { paths: ['src/a.ts'], pathCount: 1 }));
      const [first] = await requests(A);
      await due(A, p);
      await run(A, outcome('drift', { paths: ['src/a.ts', 'src/z.ts'], pathCount: 2 }));
      const open = (await requests(A)).filter((x) => x.state === 'open');
      expect(open.map((x) => x.id)).toEqual([first!.id]);
      expect(open[0]!.reason).toContain('2 paths differ: src/a.ts, src/z.ts');
      await due(A, p);
      await run(A, outcome('in_parity', { syncSha: SHA('b') }));
      expect(await requests(A)).toMatchObject([{ id: first!.id, state: 'done', resolution: 'condition_cleared' }]);
    });

    it('no_shared_history, too_large, invalid_overlay and an unsupported default branch each give one request with their approved words', async () => {
      const cases: Array<[ParityResult, Partial<ParityOutcome>, (p: { priv: string; pub: string }) => string]> = [
        ['no_shared_history', { paths: ['x.ts'], pathCount: 1 }, (p) => `Private main of ${p.priv} contains none of the last 30 commits on public main of ${p.pub}, so it was compared with public commit ${'b'.repeat(7)}. 1 paths differ: x.ts. Bring private main up to date with public main.`],
        ['too_large', { limitSide: 'private' }, (p) => `We can't check ${p.priv}: GitHub won't list all of its files in one answer. Parity between ${p.priv} and ${p.pub} isn't being checked.`],
        ['too_large', { limitSide: 'public' }, (p) => `We can't check ${p.pub}: GitHub won't list all of its files in one answer. Parity between ${p.priv} and ${p.pub} isn't being checked.`],
        ['invalid_overlay', {}, (p) => `The overlay paths of the pairing between ${p.priv} and ${p.pub} can't be read, so parity isn't being checked. Fix the overlay paths in the pairing settings.`],
        ['unsupported_branch', { limitSide: 'public' }, (p) => `${p.pub} uses a default branch other than main, so parity between ${p.priv} and ${p.pub} isn't being checked.`],
        ['unsupported_branch', { limitSide: 'private' }, (p) => `${p.priv} uses a default branch other than main, so parity between ${p.priv} and ${p.pub} isn't being checked.`],
      ];
      for (const [result, over, words] of cases) {
        const t = await seedAccount(admin, randomUUID());
        const p = await pair(t);
        await mark(t, p.pub, null);
        await run(t, outcome(result, over));
        const found = await requests(t);
        expect(found, result).toHaveLength(1);
        expect([found[0]!.target, found[0]!.reason], result).toEqual([p.pub, words(p)]);
        expect(found[0]!.reason).not.toMatch(/null|undefined/);
      }
    });

    it('unavailable leaves an open request untouched and backs off 5 minutes, then 30 minutes from the third in a row; the next push resets it', async () => {
      const p = await pair(A);
      await due(A, p);
      await run(A, outcome('drift', { paths: ['q.ts'], pathCount: 1 }));
      const [open] = await requests(A);
      const snapshot = (await admin.query(`SELECT * FROM setup_requests WHERE id = $1`, [open!.id])).rows[0];
      const secs: number[] = [];
      for (let i = 0; i < 3; i++) {
        await run(A, outcome('unavailable'));
        secs.push(Number((await row(A))!.secs));
      }
      expect(secs[0]).toBeGreaterThan(280);
      expect(secs[0]).toBeLessThanOrEqual(300);
      expect(secs[1]).toBeLessThanOrEqual(300);
      expect(secs[2]).toBeGreaterThan(1700);
      expect(secs[2]).toBeLessThanOrEqual(1800);
      expect(await row(A)).toMatchObject({ last_result: 'unavailable', streak: 3 });
      expect((await admin.query(`SELECT * FROM setup_requests WHERE id = $1`, [open!.id])).rows[0]).toEqual(snapshot);
      await mark(A, p.pub, null);
      expect(await row(A)).toMatchObject({ streak: 0 });
      expect(Number((await row(A))!.secs)).toBeLessThanOrEqual(60);
    });

    it("a person's Mark done while drift holds gives a new open request at the next check; Mark done after the drift is gone raises nothing", async () => {
      const p = await pair(A);
      await due(A, p);
      await run(A, outcome('drift', { paths: ['d.ts'], pathCount: 1 }));
      const [first] = await requests(A);
      await inTenant(A, (c) => resolveSetupRequest(c, { id: first!.id, userId: A.userId, to: 'done' }));
      expect((await requests(A)).filter((x) => x.state === 'open')).toEqual([]);
      await due(A, p);
      await run(A, outcome('drift', { paths: ['d.ts'], pathCount: 1 }));
      const open = (await requests(A)).filter((x) => x.state === 'open');
      expect(open).toHaveLength(1);
      expect(open[0]!.id).not.toBe(first!.id);
      await due(A, p);
      await run(A, outcome('in_parity', { syncSha: SHA('b') }));
      await due(A, p);
      await run(A, outcome('lag'));
      expect((await requests(A)).filter((x) => x.state === 'open')).toEqual([]);
    });

    it('a path with a control character still gives a valid request, with the character replaced', async () => {
      const p = await pair(A);
      await due(A, p);
      const counts = await sweep(async () => outcome('drift', { paths: ['bad\u0007path.ts'], pathCount: 1 }));
      await makeDue(A);
      const again = await sweep(returning(outcome('drift', { paths: ['bad\u0007path.ts'], pathCount: 1 })));
      expect(counts.failed + again.failed).toBe(0);
      const [r] = await requests(A);
      expect(r!.reason).toContain('1 paths differ: bad\uFFFDpath.ts.');
      expect((await row(A))!.last_result).toBe('drift');
    });

    it('a result that cannot be written leaves the result row and the request as they were, and the pairing backs off 5 minutes, then 30 from the third failure in a row', async () => {
      const p = await pair(A);
      await due(A, p);
      await run(A, outcome('lag'));
      const before = await row(A);
      const secs: number[] = [];
      let nextDueAt: number | null = null;
      for (let i = 0; i < 3; i++) {
        await makeDue(A);
        // A result the table refuses (its CHECK): the write rolls back, and the failure is recorded on its own.
        const counts = await sweep(returning(outcome('bogus' as ParityResult)));
        expect(counts.failed).toBe(1);
        nextDueAt = counts.nextDueAt;
        secs.push(Number((await row(A))!.secs));
      }
      expect((await row(A))!.last_result).toBe(before!.last_result);
      expect(await requests(A)).toEqual([]);
      expect(secs[0]).toBeGreaterThan(280);
      expect(secs[0]).toBeLessThanOrEqual(300);
      expect(secs[1]).toBeLessThanOrEqual(300);
      expect(secs[2]).toBeGreaterThan(1700);
      expect(secs[2]).toBeLessThanOrEqual(1800);
      expect(await row(A)).toMatchObject({ streak: 3 });
      expect(nextDueAt! - Date.now()).toBeGreaterThan(1_700_000);
    });

    it('after unavailable the next tick asked for follows the stored time: 5 minutes, then 30 minutes from the third in a row', async () => {
      const p = await pair(A);
      await due(A, p);
      const nexts: number[] = [];
      for (let i = 0; i < 3; i++) {
        await makeDue(A);
        const counts = await sweep(returning(outcome('unavailable')));
        nexts.push(counts.nextDueAt! - Date.now());
      }
      expect(nexts[0]).toBeLessThanOrEqual(300_000);
      expect(nexts[1]).toBeLessThanOrEqual(300_000);
      expect(nexts[2]).toBeGreaterThan(1_700_000);
    });

    it('a pairing whose repo has no name is dropped from the due list instead of being leased again every 5 minutes', async () => {
      const p = await pair(A);
      await mark(A, p.pub, null);
      await makeDue(A);
      await admin.query('UPDATE repos SET gh_owner = NULL WHERE id = $1', [A.repoId]);
      let ran = 0;
      const counts = await sweep(async () => (ran++, outcome('lag')));
      expect([ran, counts.skipped]).toEqual([0, 1]);
      expect((await row(A))!.secs).toBeNull();
      expect(await sweep(async () => (ran++, outcome('lag')))).toMatchObject({ listed: 0 });
    });
  });

  describe('unpair, and the database edges', () => {
    it('unpairing closes the open request as condition_cleared in the same transaction, the due row is gone, and re-pairing starts with no request', async () => {
      const p = await pair(A);
      await mark(A, p.pub, null);
      await makeDue(A);
      await sweep(returning(outcome('drift', { paths: ['u.ts'], pathCount: 1 })));
      const [open] = await requests(A);
      expect(open!.state).toBe('open');
      expect(await clearRepoPairing({ pool: runner, principal: { accountId: A.accountId, userId: A.userId } }, A.repoId)).toBe(true);
      expect(await requests(A)).toMatchObject([{ id: open!.id, state: 'done', resolution: 'condition_cleared' }]);
      expect(await row(A)).toBeUndefined();
      await pair(A, { publicRow: false });
      expect((await requests(A)).filter((x) => x.state === 'open')).toEqual([]);
    });

    it('app_user cannot delete a row, cannot read another account\'s row, and cannot update its identity columns', async () => {
      const p = await pair(A);
      await mark(A, p.pub, null);
      const asB = (sql: string) => withTenant(appUser, B.accountId, B.userId, undefined, (c) => c.query(sql, [A.repoId]));
      expect((await asB('SELECT 1 FROM plane_parity_checks WHERE repo_id = $1')).rowCount).toBe(0);
      expect((await asB(`UPDATE plane_parity_checks SET unavailable_streak = 9 WHERE repo_id = $1`)).rowCount).toBe(0);
      await expect(withTenant(appUser, A.accountId, A.userId, undefined, (c) => c.query('DELETE FROM plane_parity_checks WHERE repo_id = $1', [A.repoId]))).rejects.toMatchObject({ code: '42501' });
      await expect(withTenant(appUser, A.accountId, A.userId, undefined, (c) => c.query('UPDATE plane_parity_checks SET account_id = account_id WHERE repo_id = $1', [A.repoId]))).rejects.toMatchObject({ code: '42501' });
      await expect(withTenant(appUser, A.accountId, A.userId, undefined, (c) => c.query(`UPDATE plane_parity_checks SET last_result = 'bogus' WHERE repo_id = $1`, [A.repoId]))).rejects.toMatchObject({ code: '23514' });
    });

    it('the list is refused to app_user and platform_ops and answers 22023 to a limit outside 1..200', async () => {
      const ops = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
      try {
        await expect(appUser.query('SELECT * FROM plane_parity_list_due(10)')).rejects.toMatchObject({ code: '42501' });
        await expect(ops.query('SELECT * FROM plane_parity_list_due(10)')).rejects.toMatchObject({ code: '42501' });
      } finally {
        await ops.end();
      }
      for (const bad of [0, 201, null]) await expect(runner.query('SELECT * FROM plane_parity_list_due($1)', [bad])).rejects.toMatchObject({ code: '22023' });
    });
  });
});
