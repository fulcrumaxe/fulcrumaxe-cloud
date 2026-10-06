import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/** D#2 SANDBOX-REAPER-1a (0731): the role, the table and the four definers the end-of-item pass runs on. */
describe('sandbox reaper definers (0731)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let opsPool: Pool;
  let writerPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    writerPool = createPool(process.env.DATABASE_URL_RUN_WRITER!);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, appPool, opsPool, writerPool]) await p.end();
  });

  const exName = (a: SeedRefs, pr: number) => `ex-${a.accountId}-${a.repoId}-${pr}`;
  const fresh = () => seedAccount(admin, randomUUID());
  interface RunOpts { status?: string; itemId?: string; createdAt?: string; settleDue?: boolean; reservation?: { budget: string; state: string } }
  async function run(a: SeedRefs, name: string, pr: number | null, o: RunOpts = {}): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, sandbox_name, dispatch_repo_id, dispatch_pr_number, created_at, compute_settle_due_at)
       VALUES ($1, $2, $3, 'executor', 'production', $4, $5, $6, $7, COALESCE($8::timestamptz, now() - interval '1 hour'), CASE WHEN $9::boolean THEN now() ELSE NULL END)`,
      [id, a.accountId, o.itemId ?? null, o.status ?? 'succeeded', name, pr === null ? null : a.repoId, pr, o.createdAt ?? null, o.settleDue ?? false],
    );
    if (o.reservation) await admin.query(`INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state, budget) VALUES ($1, $2, 1, $3, $4)`, [a.accountId, id, o.reservation.state, o.reservation.budget]);
    return id;
  }
  async function item(a: SeedRefs, pr: number | null, stage: string): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, gh_number, provenance, stage) VALUES ($1, $2, $3, 'feature', $4, 'internal', $5)`, [id, a.accountId, a.repoId, pr, stage]);
    return id;
  }
  /** A name whose single run is finished and whose single item is at `stage`: the plain candidate. */
  async function plain(a: SeedRefs, pr: number, stage = 'merged', runOpts: RunOpts = {}) {
    const itemId = await item(a, pr, stage);
    const name = exName(a, pr);
    return { name, itemId, runId: await run(a, name, pr, { itemId, ...runOpts }) };
  }
  const action = (a: SeedRefs, kind: string, target: string) => admin.query(`INSERT INTO run_action_requests (account_id, kind, target_id, requested_by, principal_kind, request_hash) VALUES ($1, $2, $3, 'session:x', 'session', 'h')`, [a.accountId, kind, target]);
  const list = async (after: string | null = null) => (await writerPool.query(`SELECT * FROM sandbox_reap_candidates_terminal(50, $1)`, [after])).rows as { account_id: string; run_id: string; sandbox_name: string; reason: string }[];
  const listed = async (name: string) => (await list()).some((r) => r.sandbox_name === name);
  const claim = async (name: string) => (await writerPool.query(`SELECT sandbox_reap_claim($1, 'terminal') AS v`, [name])).rows[0].v as string;
  const done = (name: string, state: string) => writerPool.query(`SELECT sandbox_reap_done($1, $2)`, [name, state]);

  describe('who may call, and who may touch the table', () => {
    const CALLS = [
      'SELECT * FROM sandbox_reap_candidates_terminal(5, NULL)',
      "SELECT sandbox_reap_claim('ex-x', 'terminal')",
      "SELECT sandbox_reap_done('ex-x', 'deleted')",
      "SELECT sandbox_reap_unknown_names(ARRAY['ex-x'])",
    ];
    for (const sql of CALLS) {
      it(`${sql.slice(7, 40)}: app_user and platform_ops get 42501, the runner login's role does not`, async () => {
        const a = await fresh();
        await expect(appPool.query(sql)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
        await expect(withTenant(appPool, a.accountId, (c) => c.query(sql))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
        await expect(opsPool.query(sql)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
        await writerPool.query(sql).catch((e: { code?: string }) => expect(e.code).not.toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE)); // refused for its arguments at most
      });
    }

    it('app_user and platform_ops cannot select or write sandbox_reaps, directly or under a tenant; the runner login cannot read it', async () => {
      const a = await fresh();
      await claim((await plain(a, 1)).name);
      const insert = `INSERT INTO sandbox_reaps (sandbox_name, account_id, run_id, reason, state) VALUES ('ex-${randomUUID()}-${randomUUID()}-1', '${a.accountId}', '${randomUUID()}', 'terminal', 'claimed')`;
      for (const sql of ['SELECT * FROM sandbox_reaps', `UPDATE sandbox_reaps SET state = 'skipped', done_at = now()`, 'DELETE FROM sandbox_reaps', insert]) {
        await expect(appPool.query(sql)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
        await expect(withTenant(appPool, a.accountId, (c) => c.query(sql))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
        await expect(opsPool.query(sql)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
      await expect(writerPool.query('SELECT * FROM sandbox_reaps')).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('argument checks: limit 1..50, cursor shape, claim reason and name shape, done state, name list', async () => {
      for (const bad of [0, 51]) await expect(writerPool.query('SELECT * FROM sandbox_reap_candidates_terminal($1, NULL)', [bad])).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      for (const sql of [`SELECT * FROM sandbox_reap_candidates_terminal(5, 'rn-x')`, `SELECT sandbox_reap_claim('ex-a', 'idle')`, `SELECT sandbox_reap_claim('rn-1-x-2', 'terminal')`, `SELECT sandbox_reap_done('ex-a', 'claimed')`, `SELECT sandbox_reap_unknown_names(ARRAY['rlr0-1'])`]) {
        await expect(writerPool.query(sql), sql).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      }
      await expect(writerPool.query(`SELECT sandbox_reap_unknown_names($1::text[])`, [Array.from({ length: 201 }, (_, i) => `ex-${i}`)])).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
    });
  });

  describe('the candidate list: every never-delete guard', () => {
    it('lists a name whose runs are finished and whose items all merged, closed_unmerged or closed; the SQL stage list is the core one', async () => {
      const a = await fresh();
      const all = [await plain(a, 1, 'merged'), await plain(a, 2, 'closed_unmerged'), await plain(a, 3, 'closed')];
      const rows = await list();
      for (const x of all) expect(rows.find((r) => r.sandbox_name === x.name)).toMatchObject({ account_id: a.accountId, run_id: x.runId, reason: 'terminal' });
      expect((await admin.query('SELECT sandbox_reap_terminal_stages() AS v')).rows[0].v).toEqual(['merged', 'closed_unmerged', 'closed']);
    });

    it('an item at any open stage keeps the name off the list', async () => {
      const a = await fresh();
      const stages = ['triaged', 'discussing', 'spec_ready', 'in_progress', 'pr_opened', 'changes_requested', 'review_passed', 'needs_human'];
      const names: string[] = [];
      for (const [i, stage] of stages.entries()) names.push((await plain(a, i + 1, stage)).name);
      const listedNames = (await list()).map((r) => r.sandbox_name);
      expect(names.filter((n) => listedNames.includes(n))).toEqual([]);
    });

    it('the superseded twin is closed but its typed twin is open: not listed; both ended: listed', async () => {
      const a = await fresh();
      const { name } = await plain(a, 5, 'closed');
      const twin = await item(a, 5, 'in_progress');
      expect(await listed(name)).toBe(false);
      await admin.query(`UPDATE work_items SET stage = 'merged' WHERE id = $1`, [twin]);
      expect(await listed(name)).toBe(true);
    });

    it('an item linked only through a run (another issue number) must have ended too; no item at all is not "all ended"', async () => {
      const a = await fresh();
      const { name } = await plain(a, 6, 'merged');
      await run(a, name, 6, { itemId: await item(a, 99, 'in_progress') });
      const bare = exName(a, 7);
      await run(a, bare, 7);
      expect(await listed(name)).toBe(false);
      expect(await listed(bare)).toBe(false);
    });

    for (const status of ['pending', 'running', 'paused']) {
      it(`a ${status} run keeps the name off the list, even beside a finished one`, async () => {
        const a = await fresh();
        const { name, itemId } = await plain(a, 8);
        await run(a, name, 8, { itemId, status });
        expect(await listed(name)).toBe(false);
        await admin.query(`UPDATE agent_runs SET status = 'cancelled' WHERE sandbox_name = $1`, [name]);
        expect(await listed(name)).toBe(true);
      });
    }

    for (const [label, kind, target] of [['an advance on the work item', 'advance_work_item', 'item'], ['a retry of one of its runs', 'retry_run', 'run']] as const) {
      it(`a queued or leased run action (${label}) keeps the name off the list until it is done`, async () => {
        const a = await fresh();
        const { name, itemId, runId } = await plain(a, 9);
        const id = target === 'item' ? itemId : runId;
        await action(a, kind, id);
        expect(await listed(name)).toBe(false);
        await admin.query(`UPDATE run_action_requests SET state = 'claimed', claimed_until = now() + interval '5 minutes', attempts = 1 WHERE target_id = $1`, [id]);
        expect(await listed(name)).toBe(false);
        await admin.query(`UPDATE run_action_requests SET state = 'done', claimed_until = NULL, finished_at = now() WHERE target_id = $1`, [id]);
        expect(await listed(name)).toBe(true);
      });
    }

    it('a compute settle still owed, or an open compute reservation, lists the name as terminal_unsettled; a settled or model-only one is terminal', async () => {
      const a = await fresh();
      const xs = [await plain(a, 11, 'merged', { settleDue: true }), await plain(a, 12, 'merged', { reservation: { budget: 'foreground_compute', state: 'open' } }),
        await plain(a, 13, 'merged', { reservation: { budget: 'background_compute', state: 'open' } }), await plain(a, 14, 'merged', { reservation: { budget: 'foreground_compute', state: 'settled' } }),
        await plain(a, 15, 'merged', { reservation: { budget: 'model', state: 'open' } })];
      const rows = await list();
      expect(xs.map((x) => rows.find((r) => r.sandbox_name === x.name)?.reason)).toEqual(['terminal_unsettled', 'terminal_unsettled', 'terminal_unsettled', 'terminal', 'terminal']);
    });

    it('an unexpired claim keeps the name off the list, an expired one does not', async () => {
      const a = await fresh();
      const { name } = await plain(a, 25);
      await expect(claim(name)).resolves.toBe('claimed');
      expect(await listed(name)).toBe(false);
      await admin.query(`UPDATE sandbox_reaps SET claimed_at = now() - interval '11 minutes' WHERE sandbox_name = $1`, [name]);
      expect(await listed(name)).toBe(true);
    });

    it('a delete newer than the latest run takes the name off the list; a later run puts it back once it has ended', async () => {
      const a = await fresh();
      const { name, itemId } = await plain(a, 16);
      await claim(name);
      await done(name, 'deleted');
      expect(await listed(name)).toBe(false);
      await run(a, name, 16, { itemId, createdAt: new Date(Date.now() + 60_000).toISOString() });
      expect(await listed(name)).toBe(true);
    });

    it('a name that more than one account has runs under is never listed or claimed', async () => {
      const a = await fresh();
      const b = await fresh();
      const { name } = await plain(a, 17);
      // The older run is the other account's, so the newest run's account has a merged item: only the shared name keeps it off.
      await run(b, name, 17, { createdAt: new Date(Date.now() - 2 * 3_600_000).toISOString() });
      expect(await listed(name)).toBe(false);
      await expect(claim(name)).resolves.toBe('refused_not_candidate');
    });

  });

  describe('two tenants', () => {
    it("another tenant's items, stages and updated_at never decide this tenant's sandbox, and a work item cannot point at another tenant's repo", async () => {
      const a = await fresh();
      const b = await fresh();
      const aName = exName(a, 30);
      await run(a, aName, 30, { itemId: await item(a, 30, 'in_progress') }); // A's work is open
      const bPlain = await plain(b, 30, 'merged'); // B has a merged item with the same issue number
      expect(await listed(aName)).toBe(false);
      expect(await listed(bPlain.name)).toBe(true);
      // B acts as app_user in its own tenant: it ends its own items and moves updated_at. Allowed or refused, A's sandbox stays off the list.
      await withTenant(appPool, b.accountId, (c) => c.query(`UPDATE work_items SET stage = 'closed', updated_at = now() + interval '30 days' WHERE gh_number = 30`)).catch(() => undefined);
      expect(await listed(aName)).toBe(false);
      await expect(admin.query(`INSERT INTO work_items (account_id, repo_id, kind, gh_number, provenance, stage) VALUES ($1, $2, 'feature', 30, 'internal', 'merged')`, [b.accountId, a.repoId])).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
    });

    it('a claim names one sandbox and moves only that one', async () => {
      const a = await fresh();
      const b = await fresh();
      const ax = await plain(a, 31);
      const bx = await plain(b, 31);
      await expect(claim(ax.name)).resolves.toBe('claimed');
      const { rows } = await admin.query(`SELECT sandbox_name, account_id FROM sandbox_reaps WHERE sandbox_name IN ($1, $2)`, [ax.name, bx.name]);
      expect(rows).toEqual([{ sandbox_name: ax.name, account_id: a.accountId }]);
    });
  });

  describe('claim, done and unknown names', () => {
    it('claims a candidate once, then refuses it as claimed', async () => {
      const a = await fresh();
      const { name, runId } = await plain(a, 40);
      await expect(claim(name)).resolves.toBe('claimed');
      await expect(claim(name)).resolves.toBe('refused_claimed');
      expect((await admin.query(`SELECT * FROM sandbox_reaps WHERE sandbox_name = $1`, [name])).rows[0]).toMatchObject({ account_id: a.accountId, run_id: runId, reason: 'terminal', state: 'claimed', done_at: null });
    });

    it('re-checks every guard at claim time', async () => {
      const a = await fresh();
      const live = await plain(a, 41);
      await run(a, live.name, 41, { itemId: live.itemId, status: 'running' });
      const open = await plain(a, 42, 'in_progress');
      const unsettled = await plain(a, 43, 'merged', { settleDue: true });
      const queued = await plain(a, 44);
      await action(a, 'advance_work_item', queued.itemId);
      const finished = await plain(a, 45);
      await claim(finished.name);
      await done(finished.name, 'deleted');
      const got = [await claim(live.name), await claim(open.name), await claim(unsettled.name), await claim(queued.name), await claim(finished.name), await claim(`ex-${randomUUID()}-${randomUUID()}-9`)];
      expect(got).toEqual(['refused_live', 'refused_not_candidate', 'refused_unsettled', 'refused_live', 'refused_done', 'refused_not_candidate']);
      expect((await admin.query(`SELECT 1 FROM sandbox_reaps WHERE sandbox_name = ANY($1)`, [[live.name, open.name, unsettled.name, queued.name]])).rowCount).toBe(0);
    });

    it("deleted writes one sandbox.reaped audit row under the row's own account, and repeating it is a no-op", async () => {
      const a = await fresh();
      const b = await fresh();
      const { name, runId } = await plain(a, 46);
      await claim(name);
      await done(name, 'deleted');
      await done(name, 'deleted');
      const { rows } = await admin.query(`SELECT account_id, actor, payload FROM audit_log WHERE action = 'sandbox.reaped' AND payload->>'sandbox_name' = $1`, [name]);
      expect(rows).toEqual([{ account_id: a.accountId, actor: 'system:sandbox_reaper', payload: { reason: 'terminal', sandbox_name: name, run_id: runId } }]);
      expect((await admin.query(`SELECT 1 FROM audit_log WHERE action = 'sandbox.reaped' AND account_id = $1`, [b.accountId])).rowCount).toBe(0);
      expect((await admin.query(`SELECT state, done_at FROM sandbox_reaps WHERE sandbox_name = $1`, [name])).rows[0]).toMatchObject({ state: 'deleted', done_at: expect.any(Date) });
    });

    it('skipped writes no audit row and the name is a candidate again; closing a claim that is missing or closed the other way is refused', async () => {
      const a = await fresh();
      const { name } = await plain(a, 47);
      await expect(done(name, 'deleted')).rejects.toMatchObject({ code: 'P0002' });
      await claim(name);
      await done(name, 'skipped');
      expect((await admin.query(`SELECT 1 FROM audit_log WHERE action = 'sandbox.reaped' AND payload->>'sandbox_name' = $1`, [name])).rowCount).toBe(0);
      await expect(done(name, 'deleted')).rejects.toMatchObject({ code: 'P0002' });
      expect(await listed(name)).toBe(true);
    });

    it('unknown names returns the listed names no run row mentions', async () => {
      const a = await fresh();
      const { name } = await plain(a, 50);
      const stranger = `ex-${randomUUID()}-${randomUUID()}-3`;
      expect((await writerPool.query(`SELECT sandbox_reap_unknown_names($1::text[]) AS v`, [[name, stranger]])).rows[0].v).toEqual([stranger]);
    });
  });
});
