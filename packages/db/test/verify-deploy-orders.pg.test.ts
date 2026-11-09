import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { insertRunner } from './helpers/runnerFixtures.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * Migration 1004 (D#749 V2a): verify_deploy_orders on a real Postgres with the whole chain applied, written to and read as `app_user` through `withTenant`. The cloud can only
 * say "deploy sha X of repository R"; who may write what is held by the table's guard trigger, so each path is tried from the session that may take it and from the ones that may not:
 * the cloud (a tenant session with no runner in it) places an order and ends it unclaimed; a runner (the session names it) claims an order it may take and reports on the one it holds.
 */
describe('verify_deploy_orders (migration 1004)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;
  let runnerA: string;
  let runnerA2: string;

  /** The cloud: a tenant session with no runner in it. */
  const cloud = <T>(who: SeedRefs, fn: (c: PoolClient) => Promise<T>) => withTenant(appPool, who.accountId, who.userId, fn);
  /** A runner: the tenant session of its account with the runner named, the way the runner door sets it. */
  const asRunner = <T>(who: SeedRefs, runnerId: string | null, fn: (c: PoolClient) => Promise<T>) =>
    withTenant(appPool, who.accountId, who.userId, async (c) => {
      if (runnerId !== null) await c.query(`SELECT set_config('app.runner_id', $1, true)`, [runnerId]);
      return fn(c);
    });

  const place = (who: SeedRefs, over: Record<string, unknown> = {}) => {
    const v = { repo: who.repoId, row: randomUUID(), sha: randomUUID().replaceAll('-', '') + 'abcdef01', deadline: new Date(Date.now() + 3_600_000), ...over };
    return cloud(who, (c) =>
      c.query<{ id: string }>(
        `INSERT INTO verify_deploy_orders (account_id, repo_id, verify_row_id, merge_sha, deadline_at) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [who.accountId, v.repo, v.row, v.sha, v.deadline],
      ),
    );
  };
  const rowOf = async (id: string) => (await admin.query(`SELECT * FROM verify_deploy_orders WHERE id = $1`, [id])).rows[0];
  const stateOf = async (id: string) => (await rowOf(id)).state as string;
  /** The claim as the route writes it: by the named runner, one lease and one attempt more, a lease of `lease`. */
  const claim = (who: SeedRefs, id: string, runnerId: string, lease = `now() + interval '20 minutes'`, session: string | null = runnerId) =>
    asRunner(who, session, (c) =>
      c.query(`UPDATE verify_deploy_orders SET state = 'claimed', runner_id = $2, lease_generation = lease_generation + 1, attempts = attempts + 1, lease_expires_at = ${lease} WHERE id = $1`, [id, runnerId]),
    );
  const report = (who: SeedRefs, id: string, runnerId: string | null, set: string) => asRunner(who, runnerId, (c) => c.query(`UPDATE verify_deploy_orders SET ${set} WHERE id = $1`, [id]));
  const OK = `state = 'succeeded', exit_code = 0, finished_at = now()`;
  const cloudSet = (who: SeedRefs, id: string, set: string) => cloud(who, (c) => c.query(`UPDATE verify_deploy_orders SET ${set} WHERE id = $1`, [id]));

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    runnerA = await insertRunner(admin, a.accountId, a.userId);
    runnerA2 = await insertRunner(admin, a.accountId, a.userId);
    for (const id of [runnerA, runnerA2]) {
      await admin.query(`UPDATE runners SET allowed_repo_ids = ARRAY[$2]::uuid[] WHERE id = $1`, [id, a.repoId]);
      await admin.query(`INSERT INTO runner_capabilities (runner_id, account_id, capabilities) VALUES ($1, $2, '{deploy_order_v1}')`, [id, a.accountId]);
    }
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appPool.end();
  });

  describe('placing an order (the cloud)', () => {
    it('stores a pending order with no runner, no lease and no result, and stamps the clock', async () => {
      const id = (await place(a)).rows[0]!.id;
      expect(await rowOf(id)).toMatchObject({ state: 'pending', runner_id: null, lease_generation: 0, attempts: 0, lease_expires_at: null, exit_code: null, failure_code: null, output_tail: null, finished_at: null });
      expect((await rowOf(id)).created_at).toBeInstanceOf(Date);
    });

    it('enforces the shapes in the database', async () => {
      for (const sha of ['abc', 'A'.repeat(40), 'g'.repeat(40), 'a'.repeat(41)]) await expect(place(a, { sha }), sha).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(place(a, { sha: 'b'.repeat(64) }), 'a 64-character sha').resolves.toBeTruthy();
      const id = (await place(a)).rows[0]!.id;
      const refused: Array<[string, string]> = [
        ['an unknown state', `state = 'nope'`],
        ['a fourth attempt', `attempts = 4`],
        ['a pending order that names a runner', `runner_id = '${runnerA}'`],
        ['a pending order with a lease', `lease_expires_at = now()`],
        ['a result on an order that was not run', `exit_code = 0`],
        ['a failure code on an order that was not run', `failure_code = 'timeout'`],
        ['output on an order that was not run', `output_tail = 'x'`],
        ['finished_at on an open order', `finished_at = now()`],
      ];
      for (const [label, set] of refused) await expect(cloudSet(a, id, set), label).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      expect(await stateOf(id)).toBe('pending');
    });

    it('refuses an INSERT that is not a fresh pending order, written directly', async () => {
      const cols = `(account_id, repo_id, verify_row_id, merge_sha, deadline_at`;
      const base = (): unknown[] => [a.accountId, a.repoId, randomUUID(), randomUUID().replaceAll('-', '') + 'abcdef01', new Date(Date.now() + 60_000)];
      const born: Array<[string, string, string]> = [
        ['already claimed', `, state, runner_id, lease_generation, attempts, lease_expires_at`, `, 'claimed', '${runnerA}', 1, 1, now() + interval '20 minutes'`],
        ['already succeeded', `, state, exit_code, finished_at`, `, 'succeeded', 0, now()`],
        ['with a runner', `, runner_id`, `, '${runnerA}'`],
        ['with attempts', `, attempts, lease_generation`, `, 1, 1`],
      ];
      for (const [label, extraCols, extraVals] of born) {
        await expect(cloud(a, (c) => c.query(`INSERT INTO verify_deploy_orders ${cols}${extraCols}) VALUES ($1, $2, $3, $4, $5${extraVals})`, base())), label).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      }
    });

    it('a runner session never places an order', async () => {
      await expect(
        asRunner(a, runnerA, (c) => c.query(`INSERT INTO verify_deploy_orders (account_id, repo_id, verify_row_id, merge_sha, deadline_at) VALUES ($1, $2, $3, $4, now() + interval '1 hour')`, [a.accountId, a.repoId, randomUUID(), 'c'.repeat(40)])),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('one open order per repository and commit; once it has ended the same order can be placed again (the undo path)', async () => {
      const sha = 'd'.repeat(40);
      const first = (await place(a, { sha })).rows[0]!.id;
      await expect(place(a, { sha }), 'a second open order for the same commit').rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
      expect(await stateOf(first)).toBe('pending');
      await cloudSet(a, first, `state = 'cancelled', finished_at = now()`);
      const again = (await place(a, { sha })).rows[0]!.id;
      expect(again).not.toBe(first);
      expect(await stateOf(again)).toBe('pending');
      // Another commit of the same repository is its own order, and a claimed order still holds its commit.
      await claim(a, again, runnerA);
      await expect(place(a, { sha }), 'a claimed order is still open').rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
    });

    it('names a repository of the same account: another account’s repository is refused by the composite key', async () => {
      await expect(place(a, { repo: b.repoId })).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
    });
  });

  describe('claiming (a runner)', () => {
    it('moves a pending order to claimed with one lease and one attempt, by the runner the session names', async () => {
      const id = (await place(a)).rows[0]!.id;
      await claim(a, id, runnerA);
      expect(await rowOf(id)).toMatchObject({ state: 'claimed', runner_id: runnerA, lease_generation: 1, attempts: 1 });
      expect((await rowOf(id)).lease_expires_at).toBeInstanceOf(Date);
    });

    it('refuses a claim by the cloud (no runner in the session) and a claim that names a runner the session does not', async () => {
      const id = (await place(a)).rows[0]!.id;
      await expect(claim(a, id, runnerA, undefined, null), 'no runner in the session').rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(claim(a, id, runnerA, undefined, runnerA2), 'another runner’s session').rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(claim(a, id, runnerA, undefined, 'not-a-uuid'), 'a malformed session value').rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect(await stateOf(id)).toBe('pending');
    });

    it('refuses a runner that may not take the order: no capability, a repository outside its list, a revoked runner', async () => {
      const id = (await place(a)).rows[0]!.id;
      const noCap = await insertRunner(admin, a.accountId, a.userId);
      await admin.query(`UPDATE runners SET allowed_repo_ids = ARRAY[$2]::uuid[] WHERE id = $1`, [noCap, a.repoId]);
      await admin.query(`INSERT INTO runner_capabilities (runner_id, account_id, capabilities) VALUES ($1, $2, '{wake_v1}')`, [noCap, a.accountId]);
      await expect(claim(a, id, noCap), 'without deploy_order_v1').rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      const noHello = await insertRunner(admin, a.accountId, a.userId);
      await admin.query(`UPDATE runners SET allowed_repo_ids = ARRAY[$2]::uuid[] WHERE id = $1`, [noHello, a.repoId]);
      await expect(claim(a, id, noHello), 'a runner that never said hello').rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      const elsewhere = await insertRunner(admin, a.accountId, a.userId);
      await admin.query(`INSERT INTO runner_capabilities (runner_id, account_id, capabilities) VALUES ($1, $2, '{deploy_order_v1}')`, [elsewhere, a.accountId]);
      await expect(claim(a, id, elsewhere), 'a repository outside its list').rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      const revoked = await insertRunner(admin, a.accountId, a.userId);
      await admin.query(`UPDATE runners SET allowed_repo_ids = ARRAY[$2]::uuid[], revoked_at = now() WHERE id = $1`, [revoked, a.repoId]);
      await admin.query(`INSERT INTO runner_capabilities (runner_id, account_id, capabilities) VALUES ($1, $2, '{deploy_order_v1}')`, [revoked, a.accountId]);
      await expect(claim(a, id, revoked), 'a revoked runner').rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect(await stateOf(id)).toBe('pending');
    });

    it('refuses a claim past the order’s deadline and a claim that counts anything but one lease and one attempt', async () => {
      const late = (await place(a, { deadline: new Date(Date.now() - 1000) })).rows[0]!.id;
      await expect(claim(a, late, runnerA)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      const id = (await place(a)).rows[0]!.id;
      const skip = (set: string) => asRunner(a, runnerA, (c) => c.query(`UPDATE verify_deploy_orders SET state = 'claimed', runner_id = '${runnerA}', lease_expires_at = now() + interval '1 minute', ${set} WHERE id = $1`, [id]));
      await expect(skip(`lease_generation = 2, attempts = 2`), 'two leases at once').rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(skip(`lease_generation = 1, attempts = 0`), 'a lease with no attempt').rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      expect(await stateOf(id)).toBe('pending');
    });

    it('takes over a lapsed lease with one more generation and attempt, and refuses a takeover while the lease is live', async () => {
      const id = (await place(a)).rows[0]!.id;
      await claim(a, id, runnerA, `now() - interval '1 minute'`);
      await claim(a, id, runnerA2); // lapsed: runner A2 takes it over
      expect(await rowOf(id)).toMatchObject({ state: 'claimed', runner_id: runnerA2, lease_generation: 2, attempts: 2 });
      await expect(claim(a, id, runnerA), 'the new lease is live').rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      expect((await rowOf(id)).runner_id).toBe(runnerA2);
    });

    it('allows three attempts and no fourth', async () => {
      const id = (await place(a)).rows[0]!.id;
      await claim(a, id, runnerA, `now() - interval '1 minute'`);
      await claim(a, id, runnerA, `now() - interval '1 minute'`);
      await claim(a, id, runnerA, `now() - interval '1 minute'`);
      expect(await rowOf(id)).toMatchObject({ lease_generation: 3, attempts: 3 });
      await expect(claim(a, id, runnerA)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      expect((await rowOf(id)).attempts).toBe(3);
    });
  });

  describe('reporting (the runner that holds the order)', () => {
    it('records a success: exit status 0, no failure code, and the output', async () => {
      const id = (await place(a)).rows[0]!.id;
      await claim(a, id, runnerA);
      await report(a, id, runnerA, `${OK}, output_tail = 'built' || chr(10) || 'deployed'`);
      expect(await rowOf(id)).toMatchObject({ state: 'succeeded', exit_code: 0, failure_code: null, output_tail: 'built\ndeployed' });
      expect((await rowOf(id)).finished_at).toBeInstanceOf(Date);
    });

    it('records each failure: a closed code, and an exit status only with exit_nonzero', async () => {
      for (const code of ['not_configured', 'script_refused', 'spawn_failed', 'timeout']) {
        const id = (await place(a)).rows[0]!.id;
        await claim(a, id, runnerA);
        await report(a, id, runnerA, `state = 'failed', failure_code = '${code}', finished_at = now()`);
        expect(await rowOf(id), code).toMatchObject({ state: 'failed', failure_code: code, exit_code: null });
      }
      const id = (await place(a)).rows[0]!.id;
      await claim(a, id, runnerA);
      await report(a, id, runnerA, `state = 'failed', failure_code = 'exit_nonzero', exit_code = 2, finished_at = now()`);
      expect(await rowOf(id)).toMatchObject({ state: 'failed', failure_code: 'exit_nonzero', exit_code: 2 });
    });

    it('refuses a result the table’s shape does not allow', async () => {
      const id = (await place(a)).rows[0]!.id;
      await claim(a, id, runnerA);
      const refused: Array<[string, string]> = [
        ['a success with a non-zero status', `state = 'succeeded', exit_code = 1, finished_at = now()`],
        ['a success with no status', `state = 'succeeded', finished_at = now()`],
        ['a success that names a failure', `${OK}, failure_code = 'timeout'`],
        ['a failure with no code', `state = 'failed', finished_at = now()`],
        ['a failure with an unknown code', `state = 'failed', failure_code = 'on_fire', finished_at = now()`],
        ['exit_nonzero with no status', `state = 'failed', failure_code = 'exit_nonzero', finished_at = now()`],
        ['exit_nonzero with status 0', `state = 'failed', failure_code = 'exit_nonzero', exit_code = 0, finished_at = now()`],
        ['a status with a timeout', `state = 'failed', failure_code = 'timeout', exit_code = 1, finished_at = now()`],
        ['a status over 255', `state = 'failed', failure_code = 'exit_nonzero', exit_code = 256, finished_at = now()`],
        ['output over the bound', `${OK}, output_tail = repeat('x', 4101)`],
        ['a result with no finished_at', `state = 'succeeded', exit_code = 0`],
      ];
      for (const [label, set] of refused) await expect(report(a, id, runnerA, set), label).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      expect(await stateOf(id)).toBe('claimed');
    });

    it('refuses a report by the cloud, by another runner, and one that moves the lease; and one after the lease has ended', async () => {
      const id = (await place(a)).rows[0]!.id;
      await claim(a, id, runnerA);
      await expect(report(a, id, null, OK), 'the cloud').rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(report(a, id, runnerA2, OK), 'another runner').rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(report(a, id, runnerA, `${OK}, lease_generation = 2, attempts = 2`), 'a report that moves the lease').rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(report(a, id, runnerA, `${OK}, runner_id = '${runnerA2}'`), 'a report that hands the order over').rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      expect(await stateOf(id)).toBe('claimed');
      const lapsed = (await place(a)).rows[0]!.id;
      await claim(a, lapsed, runnerA, `now() - interval '1 minute'`);
      await expect(report(a, lapsed, runnerA, OK), 'a lapsed lease').rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      expect(await stateOf(lapsed)).toBe('claimed');
    });

    it('refuses a report on an order that was never claimed', async () => {
      const id = (await place(a)).rows[0]!.id;
      await expect(report(a, id, runnerA, OK)).rejects.toBeTruthy();
      expect(await stateOf(id)).toBe('pending');
    });
  });

  describe('ending an order unclaimed (the cloud) and the moves nobody may make', () => {
    it('expires or cancels a pending order and a claimed one, keeping the lease it had; a runner session never does', async () => {
      const pending = (await place(a)).rows[0]!.id;
      await cloudSet(a, pending, `state = 'expired', finished_at = now()`);
      expect(await rowOf(pending)).toMatchObject({ state: 'expired', runner_id: null });
      const held = (await place(a)).rows[0]!.id;
      await claim(a, held, runnerA);
      await cloudSet(a, held, `state = 'cancelled', finished_at = now()`);
      expect(await rowOf(held)).toMatchObject({ state: 'cancelled', runner_id: runnerA, lease_generation: 1 });
      const other = (await place(a)).rows[0]!.id;
      await claim(a, other, runnerA);
      await expect(report(a, other, runnerA, `state = 'cancelled', finished_at = now()`), 'the holder cancels').rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(report(a, other, runnerA2, `state = 'expired', finished_at = now()`), 'another runner expires').rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      const idle = (await place(a)).rows[0]!.id;
      await expect(report(a, idle, runnerA, `state = 'cancelled', finished_at = now()`), 'a runner cancels a pending order').rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect(await stateOf(other)).toBe('claimed');
      expect(await stateOf(idle)).toBe('pending');
    });

    it('ending an order does not move the lease', async () => {
      const id = (await place(a)).rows[0]!.id;
      await claim(a, id, runnerA);
      await expect(cloudSet(a, id, `state = 'expired', finished_at = now(), lease_generation = 2, attempts = 2`)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      expect(await stateOf(id)).toBe('claimed');
    });

    it('a finished order is final: nothing moves it, from the cloud or from a runner', async () => {
      for (const finish of ['succeeded', 'failed', 'expired', 'cancelled'] as const) {
        const id = (await place(a)).rows[0]!.id;
        if (finish === 'succeeded' || finish === 'failed') {
          await claim(a, id, runnerA);
          await report(a, id, runnerA, finish === 'succeeded' ? OK : `state = 'failed', failure_code = 'timeout', finished_at = now()`);
        } else await cloudSet(a, id, `state = '${finish}', finished_at = now()`);
        await expect(cloudSet(a, id, `state = 'pending', finished_at = NULL`), `${finish} to pending`).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
        await expect(cloudSet(a, id, `state = 'cancelled'`), `${finish} to cancelled`).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
        await expect(report(a, id, runnerA, `state = 'succeeded', exit_code = 0`), `${finish} to succeeded by a runner`).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
        expect(await stateOf(id)).toBe(finish);
      }
    });

    it('identity never changes, a claimed order never goes back to pending, and an update that moves nothing may not change a field', async () => {
      const id = (await place(a)).rows[0]!.id;
      for (const set of [`merge_sha = '${'f'.repeat(40)}'`, `verify_row_id = gen_random_uuid()`, `deadline_at = now()`, `created_at = now()`, `repo_id = gen_random_uuid()`]) {
        await expect(cloudSet(a, id, set), set).rejects.toBeTruthy();
      }
      await claim(a, id, runnerA);
      await expect(cloudSet(a, id, `state = 'pending', runner_id = NULL, lease_expires_at = NULL, lease_generation = 0, attempts = 0`), 'back to pending').rejects.toBeTruthy();
      await expect(cloudSet(a, id, `lease_expires_at = now() + interval '5 hours'`), 'a longer lease').rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(cloudSet(a, id, `output_tail = 'x'`), 'output on a claimed order').rejects.toBeTruthy();
      expect(await rowOf(id)).toMatchObject({ state: 'claimed', runner_id: runnerA, lease_generation: 1 });
    });

    it('when the runner row is deleted the order keeps its lease and loses only the runner, so no runner can report on it', async () => {
      const gone = await insertRunner(admin, a.accountId, a.userId);
      await admin.query(`UPDATE runners SET allowed_repo_ids = ARRAY[$2]::uuid[] WHERE id = $1`, [gone, a.repoId]);
      await admin.query(`INSERT INTO runner_capabilities (runner_id, account_id, capabilities) VALUES ($1, $2, '{deploy_order_v1}')`, [gone, a.accountId]);
      const id = (await place(a)).rows[0]!.id;
      await claim(a, id, gone);
      await admin.query(`DELETE FROM runners WHERE id = $1`, [gone]);
      expect(await rowOf(id)).toMatchObject({ state: 'claimed', runner_id: null, lease_generation: 1, attempts: 1 });
      await expect(report(a, id, runnerA, OK), 'another runner').rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(report(a, id, gone, OK), 'the deleted runner').rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });
  });

  describe('tenant isolation', () => {
    it('an account sees and changes only its own orders', async () => {
      const mine = (await place(a)).rows[0]!.id;
      const theirs = (await place(b)).rows[0]!.id;
      expect((await cloud(a, (c) => c.query(`SELECT id FROM verify_deploy_orders WHERE id = ANY($1::uuid[])`, [[mine, theirs]]))).rows.map((r) => r.id)).toEqual([mine]);
      expect((await cloud(b, (c) => c.query(`SELECT id FROM verify_deploy_orders WHERE id = ANY($1::uuid[])`, [[mine, theirs]]))).rows.map((r) => r.id)).toEqual([theirs]);
      expect((await cloudSet(b, mine, `state = 'cancelled', finished_at = now()`)).rowCount).toBe(0);
      expect(await stateOf(mine)).toBe('pending');
    });

    it('refuses a row written for another account, and a runner of one account cannot claim another account’s order', async () => {
      await expect(
        cloud(a, (c) => c.query(`INSERT INTO verify_deploy_orders (account_id, repo_id, verify_row_id, merge_sha, deadline_at) VALUES ($1, $2, $3, $4, now() + interval '1 hour')`, [b.accountId, b.repoId, randomUUID(), 'e'.repeat(40)])),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      const theirs = (await place(b)).rows[0]!.id;
      expect((await claim(a, theirs, runnerA)).rowCount).toBe(0);
      expect(await stateOf(theirs)).toBe('pending');
    });

    it('with no tenant in the session nothing is visible or writable', async () => {
      await place(a);
      const bare = await appPool.connect();
      try {
        expect((await bare.query(`SELECT 1 FROM verify_deploy_orders`)).rowCount).toBe(0);
        await expect(bare.query(`INSERT INTO verify_deploy_orders (account_id, repo_id, verify_row_id, merge_sha, deadline_at) VALUES ($1, $2, $3, $4, now() + interval '1 hour')`, [a.accountId, a.repoId, randomUUID(), '9'.repeat(40)])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      } finally {
        bare.release();
      }
    });
  });

  describe('the catalog', () => {
    it('forces row security, has the one tenant policy, no DELETE, and a pinned, closed guard function', async () => {
      expect((await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'verify_deploy_orders'`)).rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      expect((await admin.query(`SELECT polname, polroles::regrole[]::text AS roles FROM pg_policy WHERE polrelid = 'verify_deploy_orders'::regclass`)).rows).toEqual([{ polname: 'tenant_isolation', roles: '{app_user}' }]);
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE']) expect((await admin.query(`SELECT has_table_privilege('app_user', 'verify_deploy_orders', $1) AS ok`, [privilege])).rows[0].ok, privilege).toBe(true);
      for (const privilege of ['DELETE', 'TRUNCATE']) expect((await admin.query(`SELECT has_table_privilege('app_user', 'verify_deploy_orders', $1) AS ok`, [privilege])).rows[0].ok, privilege).toBe(false);
      for (const who of ['platform_ops', 'partner_user', 'agent_run_writer']) {
        expect((await admin.query(`SELECT has_any_column_privilege($1, 'verify_deploy_orders', 'SELECT, INSERT, UPDATE') AS ok`, [who])).rows[0].ok, who).toBe(false);
      }
      const fn = await admin.query(`SELECT prosecdef, proconfig, has_function_privilege('app_user', oid, 'EXECUTE') AS app, has_function_privilege('public', oid, 'EXECUTE') AS pub FROM pg_proc WHERE proname = 'verify_deploy_orders_guard'`);
      expect(fn.rows).toHaveLength(1);
      expect(fn.rows[0].prosecdef).toBe(false);
      expect(fn.rows[0].proconfig).toEqual(['search_path=pg_catalog, pg_temp']);
      expect(fn.rows[0].pub).toBe(false);
    });

    it('has no column that could hold a command, a path, a URL or a credential', async () => {
      const cols = (await admin.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'verify_deploy_orders' ORDER BY ordinal_position`)).rows.map((r) => r.column_name);
      expect(cols).toEqual(['id', 'account_id', 'repo_id', 'verify_row_id', 'merge_sha', 'state', 'runner_id', 'lease_generation', 'lease_expires_at', 'attempts', 'exit_code', 'failure_code', 'output_tail', 'deadline_at', 'created_at', 'updated_at', 'finished_at']);
    });
  });
});
