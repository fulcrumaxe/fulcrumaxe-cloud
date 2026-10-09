import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#2 SANDBOX-REAPER-1b (0760): the ephemeral candidate and claim definers, the inventory table and its writer, and the three
 * reconcile_jobs rows. Real Postgres. Every definer is EXECUTE for the runner login's role only; nothing here grants platform_ops
 * or app_user anything.
 */
describe('sandbox reaper safety net and inventory (0760)', () => {
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

  const fresh = () => seedAccount(admin, randomUUID());
  const rnName = (runId: string, role = 'project-manager') => `rn-${role.length}-${role}-${runId}`;
  const exName = (a: SeedRefs, pr: number) => `ex-${a.accountId}-${a.repoId}-${pr}`;

  interface RunOpts {
    status?: string;
    endedHoursAgo?: number | null;
    settleDue?: boolean;
    reservation?: { budget: string; state: string };
    ledger?: boolean;
    name?: string;
    role?: string;
    itemId?: string;
    pr?: number | null;
  }
  /** An rn- run: ended 25 hours ago by default, settled (a compute ledger row, nothing owed, nothing open). */
  async function rnRun(a: SeedRefs, o: RunOpts = {}): Promise<{ id: string; name: string }> {
    const id = randomUUID();
    const role = o.role ?? 'project-manager';
    const name = o.name ?? rnName(id, role);
    const hours = o.endedHoursAgo === undefined ? 25 : o.endedHoursAgo;
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, sandbox_name, dispatch_repo_id, dispatch_pr_number, created_at, compute_settle_due_at)
       VALUES ($1, $2, $3, $4, 'production', $5, $6, $7, $8, now() - interval '30 hours', CASE WHEN $9::boolean THEN now() ELSE NULL END)`,
      [id, a.accountId, o.itemId ?? null, role, o.status ?? 'succeeded', name, o.pr == null ? null : a.repoId, o.pr ?? null, o.settleDue ?? false],
    );
    // ended_at is set (once) by a trigger when a terminal status first lands; the test sets it by hand with the triggers off.
    await admin.query(`ALTER TABLE agent_runs DISABLE TRIGGER USER`);
    try {
      await admin.query(`UPDATE agent_runs SET ended_at = CASE WHEN $2::int IS NULL THEN NULL ELSE now() - make_interval(hours => $2::int) END WHERE id = $1`, [id, hours]);
    } finally {
      await admin.query(`ALTER TABLE agent_runs ENABLE TRIGGER USER`);
    }
    if (o.ledger !== false) await admin.query(`INSERT INTO ledger (account_id, kind, source, usd, run_id, budget) VALUES ($1, 'compute', 'sandbox', 0.5, $2, 'foreground_compute')`, [a.accountId, id]);
    if (o.reservation) await admin.query(`INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state, budget) VALUES ($1, $2, 1, $3, $4)`, [a.accountId, id, o.reservation.state, o.reservation.budget]);
    return { id, name };
  }
  const list = async (after: string | null = null) => (await writerPool.query(`SELECT * FROM sandbox_reap_candidates_ephemeral(50, $1)`, [after])).rows as { account_id: string; run_id: string; sandbox_name: string; reason: string }[];
  const reasonOf = async (name: string) => (await list()).find((r) => r.sandbox_name === name)?.reason;
  const claim = async (name: string) => (await writerPool.query(`SELECT sandbox_reap_claim_ephemeral($1) AS v`, [name])).rows[0].v as string;

  describe('who may call, and who may touch the tables', () => {
    const CALLS = [
      'SELECT * FROM sandbox_reap_candidates_ephemeral(5, NULL)',
      "SELECT sandbox_reap_claim_ephemeral('rn-1-x-1')",
      "SELECT * FROM sandbox_inventory_write(ARRAY[]::text[], ARRAY[]::text[], 20)",
    ];
    for (const sql of CALLS) {
      it(`${sql.slice(7, 44)}: app_user and platform_ops get 42501, the runner login's role does not`, async () => {
        const a = await fresh();
        await expect(appPool.query(sql)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
        await expect(withTenant(appPool, a.accountId, (c) => c.query(sql))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
        await expect(opsPool.query(sql)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
        await writerPool.query(sql).catch((e: { code?: string }) => expect(e.code).not.toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE)); // refused for its arguments at most
      });
    }

    it('the internal state function is not callable by anyone but its owner and the superuser', async () => {
      for (const pool of [appPool, opsPool, writerPool]) {
        await expect(pool.query(`SELECT * FROM sandbox_reap_ephemeral_state(NULL, NULL)`)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
    });

    it('sandbox_inventory: app_user, platform_ops and the runner login can neither read nor write it, directly or under a tenant', async () => {
      const a = await fresh();
      await writerPool.query(`SELECT * FROM sandbox_inventory_write(ARRAY[$1]::text[], ARRAY['stopped'], 20)`, [exName(a, 1)]);
      const insert = `INSERT INTO sandbox_inventory (account_id, live, stopped_executor, stopped_ephemeral, idle_executor, oldest_idle_at) VALUES ('${a.accountId}', 0, 0, 0, 0, NULL)`;
      for (const sql of ['SELECT * FROM sandbox_inventory', 'UPDATE sandbox_inventory SET live = 1', 'DELETE FROM sandbox_inventory', insert]) {
        await expect(appPool.query(sql), sql).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
        await expect(withTenant(appPool, a.accountId, (c) => c.query(sql)), sql).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
        await expect(opsPool.query(sql), sql).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
        await expect(writerPool.query(sql), sql).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
    });

    it('seeds the reconcile jobs (plus the idle job of 0761) with their intervals and gives platform_ops no new privilege on the reaper tables', async () => {
      const { rows } = await admin.query(`SELECT name, interval_seconds FROM reconcile_jobs WHERE name LIKE 'sandbox\\_%' ORDER BY name`);
      expect(rows).toEqual([
        { name: 'sandbox_inventory', interval_seconds: 86400 },
        { name: 'sandbox_reap_ephemeral', interval_seconds: 86400 },
        { name: 'sandbox_reap_idle', interval_seconds: 86400 },
        { name: 'sandbox_reap_terminal', interval_seconds: 900 },
      ]);
      const held = await admin.query(
        `SELECT c.relname FROM pg_class c WHERE c.relname IN ('sandbox_reaps', 'sandbox_inventory') AND (has_table_privilege('platform_ops', c.oid, 'SELECT,INSERT,UPDATE,DELETE') OR has_any_column_privilege('platform_ops', c.oid, 'SELECT,INSERT,UPDATE'))`,
      );
      expect(held.rows).toEqual([]);
    });

    it('argument checks: limit 1..50, cursor shape, claim name shape, inventory input', async () => {
      for (const bad of [0, 51]) await expect(writerPool.query('SELECT * FROM sandbox_reap_candidates_ephemeral($1, NULL)', [bad])).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      for (const sql of [`SELECT * FROM sandbox_reap_candidates_ephemeral(5, 'ex-x')`, `SELECT sandbox_reap_claim_ephemeral('ex-1-2-3')`, `SELECT sandbox_reap_claim_ephemeral('rlr0-1')`]) {
        await expect(writerPool.query(sql), sql).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      }
      const bad: [string, unknown[]][] = [
        ['a bad name', [['rlr0-1'], ['live'], 20]],
        ['a bad state', [['ex-a'], ['gone'], 20]],
        ['mismatched lengths', [['ex-a', 'ex-b'], ['live'], 20]],
        ['a duplicate name', [['ex-a', 'ex-a'], ['live', 'live'], 20]],
        ['a cap of 0', [['ex-a'], ['live'], 0]],
        ['too many names', [Array.from({ length: 20001 }, (_, i) => `ex-${i}`), Array.from({ length: 20001 }, () => 'live'), 20]],
      ];
      for (const [label, args] of bad) {
        await expect(writerPool.query('SELECT * FROM sandbox_inventory_write($1::text[], $2::text[], $3)', args), label).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      }
    });
  });

  describe('the ephemeral list: every never-delete guard (C81 criterion 6)', () => {
    it('a settled run that ended 25 hours ago is listed as ephemeral; 23 hours ago is not listed at all', async () => {
      const a = await fresh();
      const old = await rnRun(a);
      const young = await rnRun(a, { endedHoursAgo: 23 });
      expect(await list()).toContainEqual({ account_id: a.accountId, run_id: old.id, sandbox_name: old.name, reason: 'ephemeral' });
      expect(await reasonOf(young.name)).toBeUndefined();
      expect(await claim(young.name)).toBe('refused_young');
      expect(await claim(old.name)).toBe('claimed');
    });

    it('an unsettled run that ended 25 hours ago is listed as ephemeral_unsettled and its claim is refused, for each way of being unsettled', async () => {
      const a = await fresh();
      const noLedger = await rnRun(a, { ledger: false });
      const due = await rnRun(a, { settleDue: true });
      const open = await rnRun(a, { reservation: { budget: 'foreground_compute', state: 'open' } });
      const openBackground = await rnRun(a, { reservation: { budget: 'background_compute', state: 'open' } });
      for (const r of [noLedger, due, open, openBackground]) {
        expect(await reasonOf(r.name), r.name).toBe('ephemeral_unsettled');
        expect(await claim(r.name), r.name).toBe('refused_unsettled');
      }
      expect((await admin.query(`SELECT count(*)::int AS n FROM sandbox_reaps WHERE sandbox_name = ANY($1)`, [[noLedger.name, due.name, open.name, openBackground.name]])).rows[0].n).toBe(0);
    });

    it('an open model reservation does not make compute unsettled; a settled reservation does not either', async () => {
      const a = await fresh();
      const model = await rnRun(a, { reservation: { budget: 'model', state: 'open' } });
      const settled = await rnRun(a, { reservation: { budget: 'foreground_compute', state: 'settled' } });
      expect(await reasonOf(model.name)).toBe('ephemeral');
      expect(await reasonOf(settled.name)).toBe('ephemeral');
    });

    for (const status of ['pending', 'running', 'paused']) {
      it(`a ${status} run keeps the name off the list and its claim is refused, even when it has not moved for a day (a stuck run is still live)`, async () => {
        const a = await fresh();
        const r = await rnRun(a, { status, endedHoursAgo: null });
        await admin.query(`ALTER TABLE agent_runs DISABLE TRIGGER USER`);
        try {
          await admin.query(`UPDATE agent_runs SET updated_at = now() - interval '30 hours' WHERE id = $1`, [r.id]);
        } finally {
          await admin.query(`ALTER TABLE agent_runs ENABLE TRIGGER USER`);
        }
        expect(await reasonOf(r.name)).toBeUndefined();
        expect(await claim(r.name)).toBe('refused_live');
      });
    }

    it('two claims at once give the name one winner: the second waits for the first to commit, then is refused (the advisory lock)', async () => {
      const a = await fresh();
      const r = await rnRun(a);
      const first = await writerPool.connect();
      const second = await writerPool.connect();
      try {
        await first.query('BEGIN');
        expect((await first.query(`SELECT sandbox_reap_claim_ephemeral($1) AS v`, [r.name])).rows[0].v).toBe('claimed');
        const waiting = second.query(`SELECT sandbox_reap_claim_ephemeral($1) AS v`, [r.name]);
        // The second session has to be blocked on a lock, not already answered.
        let blocked = false;
        for (let i = 0; i < 100 && !blocked; i++) {
          blocked = (await admin.query(`SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%sandbox_reap_claim_ephemeral%' AND pid <> pg_backend_pid()`)).rowCount === 1;
          if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(blocked).toBe(true);
        await first.query('COMMIT');
        expect((await waiting).rows[0].v).toBe('refused_claimed');
      } finally {
        await first.query('ROLLBACK').catch(() => undefined);
        first.release();
        second.release();
      }
    });

    it('a run that predates ended_at uses its last update; a run still ended 25 hours ago by that measure is listed', async () => {
      const a = await fresh();
      const r = await rnRun(a, { endedHoursAgo: null });
      await admin.query(`ALTER TABLE agent_runs DISABLE TRIGGER USER`);
      try {
        await admin.query(`UPDATE agent_runs SET updated_at = now() - interval '26 hours' WHERE id = $1`, [r.id]);
      } finally {
        await admin.query(`ALTER TABLE agent_runs ENABLE TRIGGER USER`);
      }
      expect(await reasonOf(r.name)).toBe('ephemeral');
    });

    it('an unexpired claim keeps the name off the list; an expired one (11 minutes) does not; a completed delete keeps it off for good', async () => {
      const a = await fresh();
      const r = await rnRun(a);
      expect(await claim(r.name)).toBe('claimed');
      expect(await claim(r.name)).toBe('refused_claimed');
      expect(await reasonOf(r.name)).toBeUndefined();
      await admin.query(`UPDATE sandbox_reaps SET claimed_at = now() - interval '11 minutes' WHERE sandbox_name = $1`, [r.name]);
      expect(await reasonOf(r.name)).toBe('ephemeral');
      expect(await claim(r.name)).toBe('claimed');
      await writerPool.query(`SELECT sandbox_reap_done($1, 'deleted')`, [r.name]);
      expect(await reasonOf(r.name)).toBeUndefined();
      expect(await claim(r.name)).toBe('refused_done');
      expect((await admin.query(`SELECT payload FROM audit_log WHERE action = 'sandbox.reaped' AND payload->>'sandbox_name' = $1`, [r.name])).rows).toEqual([{ payload: { reason: 'ephemeral', sandbox_name: r.name, run_id: r.id } }]);
    });

    it('a name whose recorded runs belong to two accounts is no candidate and cannot be claimed (the tenant boundary)', async () => {
      const a = await fresh();
      const b = await fresh();
      const mine = await rnRun(a);
      // Tenant B's run recorded under tenant A's name: forced as the superuser, because 0706's trigger refuses it to everyone else.
      await rnRun(b, { name: mine.name });
      expect(await reasonOf(mine.name)).toBeUndefined();
      expect(await claim(mine.name)).toBe('refused_not_candidate');
    });

    it('an ex- name is never listed or claimed here, and a name that is no run names is refused', async () => {
      const a = await fresh();
      const ex = await rnRun(a, { name: exName(a, 7), role: 'executor', pr: 7 });
      expect(await reasonOf(ex.name)).toBeUndefined();
      await expect(claim(ex.name)).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      expect(await claim(rnName(randomUUID()))).toBe('refused_not_candidate');
    });

    it('the list pages by cursor in name order, 50 at a time at most', async () => {
      const a = await fresh();
      const made = [];
      for (let i = 0; i < 3; i++) made.push((await rnRun(a, { role: `pagerole${i}` })).name);
      const all = (await list()).map((r) => r.sandbox_name);
      const sorted = [...all].sort();
      expect(all).toEqual(sorted);
      const first = made.slice().sort()[0]!;
      const after = (await list(first)).map((r) => r.sandbox_name);
      expect(after).not.toContain(first);
      expect(after.every((n) => n > first)).toBe(true);
    });
  });

  describe('the inventory writer (C81 criterion 14)', () => {
    const write = async (names: string[], states: string[], cap = 20) =>
      (await writerPool.query(`SELECT accounts, orphans, over_cap FROM sandbox_inventory_write($1::text[], $2::text[], $3)`, [names, states, cap])).rows[0] as { accounts: number; orphans: number; over_cap: number };
    const rows = async (...ids: string[]) =>
      (await admin.query(`SELECT account_id, live, stopped_executor, stopped_ephemeral, idle_executor, oldest_idle_at FROM sandbox_inventory WHERE account_id = ANY($1) ORDER BY account_id`, [ids])).rows;
    const DAY = 86_400_000;
    /** `daysAgo` days before now, to the millisecond (what timestamptz keeps exactly). */
    const stamp = (daysAgo: number) => new Date(Math.floor(Date.now() / 1000) * 1000 - daysAgo * DAY);
    async function exRun(a: SeedRefs, pr: number, o: { status?: string; stage?: string; activity?: Date } = {}): Promise<{ name: string; itemId: string; runId: string; activity: Date }> {
      const itemId = randomUUID();
      const activity = o.activity ?? stamp(40);
      await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, gh_number, provenance, stage) VALUES ($1, $2, $3, 'feature', $4, 'internal', $5)`, [itemId, a.accountId, a.repoId, pr, o.stage ?? 'merged']);
      const runId = randomUUID();
      const name = exName(a, pr);
      await admin.query(
        `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, sandbox_name, dispatch_repo_id, dispatch_pr_number)
         VALUES ($1, $2, $3, 'executor', 'production', $4, $5, $6, $7)`,
        [runId, a.accountId, itemId, o.status ?? 'succeeded', name, a.repoId, pr],
      );
      // Last activity is controlled by hand: the run and its item both carry the same stamp (the run was created a day before it).
      await admin.query(`ALTER TABLE agent_runs DISABLE TRIGGER USER`);
      await admin.query(`ALTER TABLE work_items DISABLE TRIGGER USER`);
      try {
        await admin.query(`UPDATE agent_runs SET created_at = $2::timestamptz - interval '1 day', updated_at = $2::timestamptz, ended_at = $2::timestamptz WHERE id = $1`, [runId, activity]);
        await admin.query(`UPDATE work_items SET updated_at = $2::timestamptz WHERE id = $1`, [itemId, activity]);
      } finally {
        await admin.query(`ALTER TABLE agent_runs ENABLE TRIGGER USER`);
        await admin.query(`ALTER TABLE work_items ENABLE TRIGGER USER`);
      }
      return { name, itemId, runId, activity };
    }

    it('given a fake estate of two accounts in mixed states, the rows match hand-computed counts', async () => {
      const a = await fresh();
      const b = await fresh();
      // Account A: 3 stopped executors (one has a queued action, one a live run: neither is idle), 1 live executor, 2 stopped rn-, 1 live rn-.
      const a1 = await exRun(a, 1, { activity: stamp(20) });
      const a2 = await exRun(a, 2, { activity: stamp(50) });
      const a3 = await exRun(a, 3, { activity: stamp(10) });
      const a4 = await exRun(a, 4, { status: 'running', stage: 'in_progress' });
      await admin.query(`INSERT INTO run_action_requests (account_id, kind, target_id, requested_by, principal_kind, request_hash) VALUES ($1, 'advance_work_item', $2, 'session:x', 'session', 'h')`, [a.accountId, a2.itemId]);
      const ra = [await rnRun(a), await rnRun(a), await rnRun(a, { status: 'running', endedHoursAgo: null })];
      // Account B: 2 stopped executors, both idle; 1 stopped rn-.
      const b1 = await exRun(b, 1, { activity: stamp(70) });
      const b2 = await exRun(b, 2, { activity: stamp(60) });
      const rb = await rnRun(b);
      const result = await write(
        [a1.name, a2.name, a3.name, a4.name, ra[0]!.name, ra[1]!.name, ra[2]!.name, b1.name, b2.name, rb.name],
        ['stopped', 'stopped', 'stopped', 'live', 'stopped', 'stopped', 'live', 'stopped', 'stopped', 'stopped'],
      );
      expect(result.orphans).toBe(0);
      expect(await rows(a.accountId)).toEqual([
        { account_id: a.accountId, live: 2, stopped_executor: 3, stopped_ephemeral: 2, idle_executor: 2, oldest_idle_at: a1.activity },
      ]);
      expect(await rows(b.accountId)).toEqual([
        { account_id: b.accountId, live: 0, stopped_executor: 2, stopped_ephemeral: 1, idle_executor: 2, oldest_idle_at: b1.activity },
      ]);
      expect(result.accounts).toBeGreaterThanOrEqual(2);
    });

    it('a name no run owns, or that runs of two accounts claim, is an orphan: counted, never written', async () => {
      const a = await fresh();
      const b = await fresh();
      const ours = await exRun(a, 9);
      const stray = `ex-${randomUUID()}-${randomUUID()}-5`;
      const mine = await rnRun(a);
      await rnRun(b, { name: mine.name }); // forced: two accounts under one name
      const result = await write([ours.name, stray, mine.name], ['stopped', 'stopped', 'stopped']);
      expect(result.orphans).toBe(2);
      expect(await rows(a.accountId)).toEqual([{ account_id: a.accountId, live: 0, stopped_executor: 1, stopped_ephemeral: 0, idle_executor: 1, oldest_idle_at: ours.activity }]);
      expect(await rows(b.accountId)).toEqual([]);
    });

    it('it replaces the previous pass and keeps no history: a name that vanished leaves no row, an empty list empties the table', async () => {
      const a = await fresh();
      const r = await exRun(a, 1);
      await write([r.name], ['stopped']);
      expect((await rows(a.accountId)).length).toBe(1);
      await write([r.name], ['live']);
      expect(await rows(a.accountId)).toEqual([{ account_id: a.accountId, live: 1, stopped_executor: 0, stopped_ephemeral: 0, idle_executor: 0, oldest_idle_at: null }]);
      expect(await write([], [])).toEqual({ accounts: 0, orphans: 0, over_cap: 0 });
      expect((await admin.query(`SELECT count(*)::int AS n FROM sandbox_inventory`)).rows[0].n).toBe(0);
    });

    it('over_cap counts the accounts whose idle executors exceed the cap given', async () => {
      const a = await fresh();
      const names: string[] = [];
      for (let pr = 1; pr <= 4; pr++) names.push((await exRun(a, pr)).name);
      const states = names.map(() => 'stopped');
      expect((await write(names, states, 4)).over_cap).toBe(0);
      expect((await write(names, states, 3)).over_cap).toBe(1);
    });

    it('two writers at once leave one consistent set of rows', async () => {
      const a = await fresh();
      const r = await exRun(a, 1);
      await Promise.all([write([r.name], ['stopped']), write([r.name], ['stopped']), write([r.name], ['live'])]);
      expect((await rows(a.accountId)).length).toBe(1);
    });
  });
});
