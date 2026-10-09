import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#2 SANDBOX-REAPER-2 (0761): the Build again lock (agent_run_create and the reaper claims share one advisory lock, FXR01 on a
 * run created inside a claim), the 7-day idle rule and the cap of 20. Real Postgres, real roles.
 */
describe('sandbox reaper lock, idle rule and cap (0761)', () => {
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
  const exName = (a: SeedRefs, pr: number) => `ex-${a.accountId}-${a.repoId}-${pr}`;
  const hours = (n: number) => `${n} hours`;

  interface Sandbox {
    name: string;
    itemId: string;
    runId: string;
  }
  interface Opts {
    stage?: string;
    /** Hours since the latest run activity and the item's last update. */
    idleHours?: number;
    status?: string;
    settleDue?: boolean;
    noItem?: boolean;
  }
  /** One executor sandbox: a finished run under the name and one work item sharing it, both last touched `idleHours` ago. */
  async function sandbox(a: SeedRefs, pr: number, o: Opts = {}): Promise<Sandbox> {
    const idle = hours(o.idleHours ?? 24 * 8);
    const itemId = randomUUID();
    if (!o.noItem) {
      await admin.query(
        `INSERT INTO work_items (id, account_id, repo_id, kind, gh_number, provenance, stage, created_at, updated_at)
         VALUES ($1, $2, $3, 'feature', $4, 'internal', $5, now() - $6::interval - interval '1 hour', now() - $6::interval)`,
        [itemId, a.accountId, a.repoId, pr, o.stage ?? 'needs_human', idle],
      );
    }
    const runId = randomUUID();
    const name = exName(a, pr);
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, sandbox_name, dispatch_repo_id, dispatch_pr_number, created_at, updated_at, compute_settle_due_at)
       VALUES ($1, $2, $3, 'executor', 'production', $4, $5, $6, $7, now() - $8::interval - interval '1 hour', now() - $8::interval, CASE WHEN $9::boolean THEN now() ELSE NULL END)`,
      [runId, a.accountId, o.noItem ? null : itemId, o.status ?? 'succeeded', name, a.repoId, pr, idle, o.settleDue ?? false],
    );
    // ended_at is set by a trigger when a terminal status first lands; the test pins it (and updated_at) by hand with the triggers off.
    await admin.query('ALTER TABLE agent_runs DISABLE TRIGGER USER');
    try {
      await admin.query(`UPDATE agent_runs SET ended_at = CASE WHEN status IN ('pending', 'running', 'paused') THEN NULL ELSE now() - $2::interval END, updated_at = now() - $2::interval WHERE id = $1`, [runId, idle]);
    } finally {
      await admin.query('ALTER TABLE agent_runs ENABLE TRIGGER USER');
    }
    return { name, itemId, runId };
  }
  const action = async (a: SeedRefs, target: string, state = 'accepted') => {
    await admin.query(`INSERT INTO run_action_requests (account_id, kind, target_id, requested_by, principal_kind, request_hash) VALUES ($1, 'advance_work_item', $2, 'session:x', 'session', 'h')`, [a.accountId, target]);
    if (state === 'claimed') await admin.query(`UPDATE run_action_requests SET state = 'claimed', claimed_until = now() + interval '5 minutes', attempts = 1 WHERE target_id = $1`, [target]);
    if (state === 'done') await admin.query(`UPDATE run_action_requests SET state = 'done', claimed_until = NULL, finished_at = now() WHERE target_id = $1`, [target]);
  };

  /** Every page of the list (other tests' accounts share the database, so one page of 50 may not reach this test's names). */
  const idleList = async (cap = 20) => {
    const all: { account_id: string; run_id: string; sandbox_name: string; reason: string }[] = [];
    for (let after: string | null = null; ; ) {
      const page = (await writerPool.query(`SELECT * FROM sandbox_reap_candidates_idle(50, $1, $2)`, [after, cap])).rows as typeof all;
      all.push(...page);
      if (page.length < 50) return all;
      after = page[page.length - 1]!.sandbox_name;
    }
  };
  const reasonOf = async (name: string, cap = 20) => (await idleList(cap)).find((r) => r.sandbox_name === name)?.reason;
  const claimIdle = async (name: string, reason: string, cap = 20) => (await writerPool.query(`SELECT sandbox_reap_claim_idle($1, $2, $3) AS v`, [name, reason, cap])).rows[0].v as string;
  const claimTerminal = async (name: string) => (await writerPool.query(`SELECT sandbox_reap_claim($1, 'terminal') AS v`, [name])).rows[0].v as string;
  const done = (name: string, state: string) => writerPool.query('SELECT sandbox_reap_done($1, $2)', [name, state]);

  /** Every create a test opened: rolled back after the test, so a failed assertion never leaves a lock held for the next one. */
  const opened: { rollback: () => Promise<void> }[] = [];
  afterEach(async () => {
    for (const c of opened.splice(0)) await c.rollback();
  });

  const CREATE_SQL = `SELECT agent_run_create($1::uuid, $2::uuid, NULL, NULL, $3::text, 'production', NULL, NULL, $4::uuid, $5::bigint, NULL,
                                              jsonb_build_object('accountId', $2::uuid::text), repeat('a', 64), NULL, NULL, NULL)`;
  /** A create in its own transaction on a dedicated connection, so a test decides when it commits. */
  async function openCreate(a: SeedRefs, pr: number, role = 'executor') {
    const client = await writerPool.connect();
    const id = randomUUID();
    let closed = false;
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.account_id', $1, true)", [a.accountId]);
    const handle = {
      id,
      client,
      call: () => client.query(CREATE_SQL, [id, a.accountId, role, a.repoId, pr]),
      commit: async () => {
        if (closed) return;
        closed = true;
        await client.query('COMMIT');
        client.release();
      },
      rollback: async () => {
        if (closed) return;
        closed = true;
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      },
    };
    opened.push(handle);
    return handle;
  }
  const createOnce = async (a: SeedRefs, pr: number, role = 'executor') => {
    const c = await openCreate(a, pr, role);
    try {
      await c.call();
    } catch (err) {
      await c.rollback();
      throw err;
    }
    await c.commit();
    return c.id;
  };
  /** True while `p` has not settled after a short wait. */
  async function stillWaiting(p: Promise<unknown>): Promise<boolean> {
    let settled = false;
    p.then(() => (settled = true), () => (settled = true));
    await new Promise((r) => setTimeout(r, 300));
    return !settled;
  }

  describe('who may call, who may read, and what agent_run_create keeps', () => {
    it('the idle definers: app_user and platform_ops get 42501, the runner login does not; the internal state function is nobody\'s', async () => {
      const a = await fresh();
      const CALLS = ['SELECT * FROM sandbox_reap_candidates_idle(5, NULL, 20)', "SELECT sandbox_reap_claim_idle('ex-x', 'idle', 20)"];
      for (const sql of CALLS) {
        await expect(appPool.query(sql), sql).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
        await expect(withTenant(appPool, a.accountId, (c) => c.query(sql)), sql).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
        await expect(opsPool.query(sql), sql).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
        await writerPool.query(sql).catch((e: { code?: string }) => expect(e.code).not.toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE));
      }
      for (const pool of [appPool, opsPool, writerPool]) {
        await expect(pool.query('SELECT * FROM sandbox_reap_idle_state(NULL, 20)')).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
    });

    it('the claim guard answers one boolean to platform_ops (inside agent_run_create) and to nobody else; platform_ops still reads nothing of sandbox_reaps', async () => {
      const probe = "SELECT sandbox_reap_claimed('ex-x')";
      await expect(opsPool.query(probe)).resolves.toBeDefined();
      for (const pool of [appPool, writerPool]) await expect(pool.query(probe)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      const held = await admin.query(
        `SELECT c.relname FROM pg_class c WHERE c.relname IN ('sandbox_reaps', 'sandbox_inventory') AND (has_table_privilege('platform_ops', c.oid, 'SELECT,INSERT,UPDATE,DELETE') OR has_any_column_privilege('platform_ops', c.oid, 'SELECT,INSERT,UPDATE'))`,
      );
      expect(held.rows).toEqual([]);
      await expect(opsPool.query('SELECT * FROM sandbox_reaps')).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('agent_run_create keeps its owner and its ACL (platform_ops; EXECUTE for agent_run_writer and runner_lease_definer only), and there is one of it', async () => {
      const { rows } = await admin.query(
        `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig,
                (SELECT array_agg(DISTINCT pg_get_userbyid(a.grantee)::text ORDER BY pg_get_userbyid(a.grantee)::text) FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner) AS grantees,
                (SELECT bool_or(a.grantee = 0 OR a.is_grantable) FROM aclexplode(p.proacl) a) AS loose
           FROM pg_proc p WHERE p.proname = 'agent_run_create'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ owner: 'platform_ops', prosecdef: true, grantees: ['agent_run_writer', 'runner_lease_definer'], loose: false });
      expect(rows[0].proconfig).toEqual(['search_path=pg_catalog, public, pg_temp']);
    });

    it('the new roles and definers have the guard_definer shape: NOLOGIN, member-less, pinned search_path, EXECUTE as designed', async () => {
      const roles = await admin.query(
        `SELECT rolname, rolcanlogin, rolsuper, rolbypassrls, (SELECT count(*) FROM pg_auth_members m WHERE m.roleid = r.oid)::int AS members
           FROM pg_roles r WHERE rolname IN ('sandbox_idle_reaper', 'sandbox_claim_guard') ORDER BY 1`,
      );
      expect(roles.rows).toEqual([
        { rolname: 'sandbox_claim_guard', rolcanlogin: false, rolsuper: false, rolbypassrls: false, members: 0 },
        { rolname: 'sandbox_idle_reaper', rolcanlogin: false, rolsuper: false, rolbypassrls: false, members: 0 },
      ]);
      const fns = await admin.query(
        `SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.proconfig,
                (SELECT array_agg(DISTINCT pg_get_userbyid(a.grantee)::text ORDER BY pg_get_userbyid(a.grantee)::text) FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner) AS grantees
           FROM pg_proc p WHERE p.proname IN ('sandbox_reap_claimed', 'sandbox_reap_idle_state', 'sandbox_reap_candidates_idle', 'sandbox_reap_claim_idle') ORDER BY 1`,
      );
      expect(fns.rows.map((r) => [r.proname, r.owner, r.grantees])).toEqual([
        ['sandbox_reap_candidates_idle', 'sandbox_idle_reaper', ['agent_run_writer']],
        ['sandbox_reap_claim_idle', 'sandbox_idle_reaper', ['agent_run_writer']],
        ['sandbox_reap_claimed', 'sandbox_claim_guard', ['platform_ops']],
        ['sandbox_reap_idle_state', 'sandbox_idle_reaper', null],
      ]);
      for (const f of fns.rows) expect(f.proconfig).toEqual(['search_path=pg_catalog, public, pg_temp']);
    });

    it('the idle state function repeats the terminal stage list of 0731 (and of @fx/core)', async () => {
      const stages = (await admin.query('SELECT sandbox_reap_terminal_stages() AS v')).rows[0].v as string[];
      const def = (await admin.query(`SELECT pg_get_functiondef('sandbox_reap_idle_state(uuid, integer)'::regprocedure) AS d`)).rows[0].d as string;
      expect(def).toContain(`ARRAY[${stages.map((x) => `'${x}'`).join(', ')}]`);
    });

    it('seeds the idle job daily', async () => {
      const { rows } = await admin.query(`SELECT interval_seconds FROM reconcile_jobs WHERE name = 'sandbox_reap_idle'`);
      expect(rows).toEqual([{ interval_seconds: 86400 }]);
    });

    it('argument checks: limit, cap, cursor, reason and name shape', async () => {
      for (const bad of [0, 51]) await expect(writerPool.query('SELECT * FROM sandbox_reap_candidates_idle($1, NULL, 20)', [bad])).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      for (const cap of [0, 1001]) await expect(writerPool.query('SELECT * FROM sandbox_reap_candidates_idle(5, NULL, $1)', [cap])).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      const good = `ex-${randomUUID()}-${randomUUID()}-1`;
      for (const sql of [
        `SELECT * FROM sandbox_reap_candidates_idle(5, 'rn-x', 20)`,
        `SELECT sandbox_reap_claim_idle('${good}', 'terminal', 20)`,
        `SELECT sandbox_reap_claim_idle('${good}', 'idle', 0)`,
        `SELECT sandbox_reap_claim_idle('ex-x', 'idle', 20)`,
        `SELECT sandbox_reap_claim_idle('rn-1-x-${randomUUID()}', 'idle', 20)`,
        `SELECT sandbox_reap_claim_idle('ex-${'-'.repeat(36)}-${randomUUID()}-1', 'idle', 20)`,
      ]) {
        await expect(writerPool.query(sql), sql).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      }
    });
  });

  describe('the lock: agent_run_create and a claim on one name have exactly one winner (criterion 16)', () => {
    it('the claim commits first: the create waits for it, then raises FXR01 and writes nothing', async () => {
      const a = await fresh();
      const s = await sandbox(a, 1, { stage: 'merged' });
      const claimer = await writerPool.connect();
      try {
        await claimer.query('BEGIN');
        expect((await claimer.query(`SELECT sandbox_reap_claim($1, 'terminal') AS v`, [s.name])).rows[0].v).toBe('claimed');
        const create = await openCreate(a, 1);
        const pending = create.call().then(() => 'created', (e: { code?: string }) => e.code);
        expect(await stillWaiting(pending)).toBe(true); // the claim holds the name's lock until it commits
        await claimer.query('COMMIT');
        expect(await pending).toBe('FXR01');
        await create.rollback();
      } finally {
        await claimer.query('ROLLBACK').catch(() => undefined);
        claimer.release();
      }
      expect((await admin.query(`SELECT count(*)::int AS n FROM agent_runs WHERE sandbox_name IS NOT NULL AND account_id = $1 AND status = 'pending'`, [a.accountId])).rows[0].n).toBe(0);
      expect((await admin.query(`SELECT count(*)::int AS n FROM agent_runs WHERE account_id = $1 AND dispatch_pr_number = 1`, [a.accountId])).rows[0].n).toBe(1); // only the seeded one
    });

    it('the create commits first: the claim waits for it, then answers refused_live', async () => {
      const a = await fresh();
      const s = await sandbox(a, 1, { stage: 'merged' });
      const create = await openCreate(a, 1);
      await create.call(); // the lock is held, the run row is not yet visible to anyone else
      const claim = writerPool.query(`SELECT sandbox_reap_claim($1, 'terminal') AS v`, [s.name]).then((r) => r.rows[0].v as string);
      try {
        expect(await stillWaiting(claim)).toBe(true);
      } finally {
        await create.commit();
      }
      expect(await claim).toBe('refused_live');
      expect((await admin.query(`SELECT state FROM sandbox_reaps WHERE sandbox_name = $1`, [s.name])).rows).toEqual([]);
    });

    it('the same two orders hold for the idle claim', async () => {
      const a = await fresh();
      const s1 = await sandbox(a, 1, { idleHours: 24 * 8 });
      const claimer = await writerPool.connect();
      try {
        await claimer.query('BEGIN');
        expect((await claimer.query(`SELECT sandbox_reap_claim_idle($1, 'idle', 20) AS v`, [s1.name])).rows[0].v).toBe('claimed');
        const create = await openCreate(a, 1);
        const pending = create.call().then(() => 'created', (e: { code?: string }) => e.code);
        expect(await stillWaiting(pending)).toBe(true);
        await claimer.query('COMMIT');
        expect(await pending).toBe('FXR01');
        await create.rollback();
      } finally {
        await claimer.query('ROLLBACK').catch(() => undefined);
        claimer.release();
      }
      const s2 = await sandbox(a, 2, { idleHours: 24 * 8 });
      const create2 = await openCreate(a, 2);
      await create2.call();
      const claim = claimIdle(s2.name, 'idle');
      try {
        expect(await stillWaiting(claim)).toBe(true);
      } finally {
        await create2.commit();
      }
      expect(await claim).toBe('refused_live');
    });

    it('a claim expires after 10 minutes, and a closed claim (deleted or skipped) no longer blocks', async () => {
      const a = await fresh();
      const s = await sandbox(a, 1, { stage: 'merged' });
      expect(await claimTerminal(s.name)).toBe('claimed');
      await expect(createOnce(a, 1)).rejects.toMatchObject({ code: 'FXR01', message: 'sandbox_reaping' });
      await admin.query(`UPDATE sandbox_reaps SET claimed_at = now() - interval '9 minutes' WHERE sandbox_name = $1`, [s.name]);
      await expect(createOnce(a, 1)).rejects.toMatchObject({ code: 'FXR01' });
      await admin.query(`UPDATE sandbox_reaps SET claimed_at = now() - interval '11 minutes' WHERE sandbox_name = $1`, [s.name]);
      await expect(createOnce(a, 1)).resolves.toBeDefined();
    });

    it('Build again during a claim is refused, goes through once the claim is marked deleted, and its run is live so the name is not reaped again', async () => {
      const a = await fresh();
      const s = await sandbox(a, 1, { stage: 'needs_human', idleHours: 24 * 8 });
      expect(await claimIdle(s.name, 'idle')).toBe('claimed');
      await expect(createOnce(a, 1)).rejects.toMatchObject({ code: 'FXR01' });
      await done(s.name, 'deleted');
      const runId = await createOnce(a, 1);
      expect((await admin.query(`SELECT status FROM agent_runs WHERE id = $1`, [runId])).rows[0].status).toBe('pending');
      expect(await reasonOf(s.name)).toBeUndefined();
      expect(await claimIdle(s.name, 'idle')).not.toBe('claimed');
    });

    it('a skipped claim no longer blocks either', async () => {
      const a = await fresh();
      const s = await sandbox(a, 1, { idleHours: 24 * 8 });
      expect(await claimIdle(s.name, 'idle')).toBe('claimed');
      await done(s.name, 'skipped');
      await expect(createOnce(a, 1)).resolves.toBeDefined();
    });

    it('only an executor run that names a repo and a pull request takes the lock', async () => {
      const a = await fresh();
      const s = await sandbox(a, 1, { stage: 'merged' });
      const claimer = await writerPool.connect();
      try {
        await claimer.query('BEGIN');
        expect((await claimer.query(`SELECT sandbox_reap_claim($1, 'terminal') AS v`, [s.name])).rows[0].v).toBe('claimed');
        // Another role, and another pull request of the same account, are not held up by the claim (and the claim is not theirs).
        await expect(createOnce(a, 1, 'code-reviewer')).resolves.toBeDefined();
        await expect(createOnce(a, 2)).resolves.toBeDefined();
      } finally {
        await claimer.query('ROLLBACK');
        claimer.release();
      }
    });

    it('a claim on one account\'s name never holds up another account\'s create', async () => {
      const a = await fresh();
      const b = await fresh();
      const s = await sandbox(a, 1, { stage: 'merged' });
      expect(await claimTerminal(s.name)).toBe('claimed');
      await expect(createOnce(b, 1)).resolves.toBeDefined();
    });
  });

  describe('the idle rule (criterion 18)', () => {
    it('8 days idle at needs_human: listed idle and claimable; 6 days: kept', async () => {
      const a = await fresh();
      const old = await sandbox(a, 1, { stage: 'needs_human', idleHours: 24 * 8 });
      const young = await sandbox(a, 2, { stage: 'needs_human', idleHours: 24 * 6 });
      expect(await reasonOf(old.name)).toBe('idle');
      expect(await reasonOf(young.name)).toBeUndefined();
      expect(await claimIdle(young.name, 'idle')).toBe('refused_not_candidate');
      expect(await claimIdle(old.name, 'idle')).toBe('claimed');
    });

    it('8 days idle with a queued or leased run action: kept (also when the action targets one of its runs)', async () => {
      const a = await fresh();
      const queued = await sandbox(a, 1);
      const leased = await sandbox(a, 2);
      const onRun = await sandbox(a, 3);
      const finished = await sandbox(a, 4);
      await action(a, queued.itemId, 'accepted');
      await action(a, leased.itemId, 'claimed');
      await action(a, onRun.runId, 'accepted');
      await action(a, finished.itemId, 'done');
      for (const s of [queued, leased, onRun]) {
        expect(await reasonOf(s.name), s.name).toBeUndefined();
        expect(await claimIdle(s.name, 'idle'), s.name).toBe('refused_live');
      }
      expect(await reasonOf(finished.name)).toBe('idle'); // a settled action is not a lock
    });

    it('a live run keeps it, however old its row; an owed compute settle keeps it', async () => {
      const a = await fresh();
      const live = await sandbox(a, 1, { status: 'paused' });
      const owed = await sandbox(a, 2, { settleDue: true });
      expect(await reasonOf(live.name)).toBeUndefined();
      expect(await claimIdle(live.name, 'idle')).toBe('refused_live');
      expect(await reasonOf(owed.name)).toBeUndefined();
      expect(await claimIdle(owed.name, 'idle')).toBe('refused_unsettled');
    });

    it('a recent work item update keeps it (last activity is the latest of the runs and the items)', async () => {
      const a = await fresh();
      const s = await sandbox(a, 1, { idleHours: 24 * 8 });
      expect(await reasonOf(s.name)).toBe('idle');
      await admin.query(`UPDATE work_items SET updated_at = now() - interval '2 days' WHERE id = $1`, [s.itemId]);
      expect(await reasonOf(s.name)).toBeUndefined();
    });

    it('a name with no work item at all ages by its runs; one covered by the terminal pass is the terminal pass\'s, not the idle rule\'s', async () => {
      const a = await fresh();
      const orphanRun = await sandbox(a, 1, { noItem: true });
      const merged = await sandbox(a, 2, { stage: 'merged' });
      expect(await reasonOf(orphanRun.name)).toBe('idle');
      expect(await reasonOf(merged.name)).toBeUndefined();
      expect(await claimIdle(merged.name, 'idle')).toBe('refused_not_candidate');
      expect((await writerPool.query(`SELECT sandbox_name FROM sandbox_reap_candidates_terminal(50, NULL)`)).rows.map((r) => r.sandbox_name)).toContain(merged.name);
    });

    it('a name that shares an item with a twin still open is not covered: the superseded row closed, its typed twin at needs_human', async () => {
      const a = await fresh();
      const s = await sandbox(a, 1, { stage: 'closed' });
      await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, gh_number, provenance, stage, updated_at) VALUES ($1, $2, $3, 'feature', 1, 'internal', 'needs_human', now() - interval '9 days')`, [randomUUID(), a.accountId, a.repoId]);
      expect(await reasonOf(s.name)).toBe('idle');
    });

    it('the refusals of a claim: an unexpired claim, a delete newer than the latest run, and a claim for the wrong reason', async () => {
      const a = await fresh();
      const s = await sandbox(a, 1);
      expect(await claimIdle(s.name, 'cap')).toBe('refused_not_candidate');
      expect(await claimIdle(s.name, 'idle')).toBe('claimed');
      expect(await claimIdle(s.name, 'idle')).toBe('refused_claimed');
      expect(await reasonOf(s.name)).toBeUndefined(); // claimed names leave the list
      await done(s.name, 'deleted');
      expect(await claimIdle(s.name, 'idle')).toBe('refused_done');
      expect(await reasonOf(s.name)).toBeUndefined();
      expect((await admin.query(`SELECT count(*)::int AS n FROM audit_log WHERE account_id = $1 AND action = 'sandbox.reaped'`, [a.accountId])).rows[0].n).toBe(1);
    });

    it('one tenant cannot age, refresh or cover another tenant\'s name (every check joins on the row\'s own account)', async () => {
      const a = await fresh();
      const b = await fresh();
      const s = await sandbox(a, 1, { stage: 'needs_human' });
      const theirs = await sandbox(b, 1, { stage: 'merged', idleHours: 1 });
      // b, as app_user, moves every work item it can see to a terminal stage and touches its updated_at.
      await withTenant(appPool, b.accountId, (c) => c.query(`UPDATE work_items SET stage = 'closed', updated_at = now()`));
      await withTenant(appPool, b.accountId, (c) => c.query(`UPDATE work_items SET updated_at = now() + interval '30 days'`));
      expect(await reasonOf(s.name)).toBe('idle');
      expect(await claimIdle(s.name, 'idle')).toBe('claimed');
      expect(await reasonOf(theirs.name)).toBeUndefined();
      // And a's own items are invisible to b's session.
      const seen = await withTenant(appPool, b.accountId, (c) => c.query('SELECT count(*)::int AS n FROM work_items WHERE account_id = $1', [a.accountId]));
      expect(seen.rows[0].n).toBe(0);
    });
  });

  describe('the cap (criterion 19)', () => {
    /** `count` idle sandboxes for one account, none past 7 days, in a fixed order: index 0 is the oldest. */
    async function estate(a: SeedRefs, count: number) {
      const out: Sandbox[] = [];
      for (let i = 0; i < count; i++) out.push(await sandbox(a, i + 1, { idleHours: 24 * 6 - i }));
      return out;
    }

    it('23 idle sandboxes: the 3 oldest are listed (reason cap) and the newest 20 are kept', async () => {
      const a = await fresh();
      const all = await estate(a, 23);
      const listed = (await idleList()).filter((r) => r.account_id === a.accountId);
      expect(listed.map((r) => [r.sandbox_name, r.reason]).sort()).toEqual(all.slice(0, 3).map((s) => [s.name, 'cap']).sort());
      expect(await claimIdle(all[0]!.name, 'cap')).toBe('claimed');
      expect(await claimIdle(all[22]!.name, 'cap')).toBe('refused_not_candidate');
    });

    it('with one of the 3 oldest locked by a queued action, the next-oldest unlocked one goes instead', async () => {
      const a = await fresh();
      const all = await estate(a, 23);
      await action(a, all[1]!.itemId, 'accepted');
      const listed = (await idleList()).filter((r) => r.account_id === a.accountId);
      expect(listed.map((r) => r.sandbox_name).sort()).toEqual([all[0]!.name, all[2]!.name, all[3]!.name].sort());
      expect(await claimIdle(all[1]!.name, 'cap')).toBe('refused_live');
    });

    it('20 or fewer: nothing; the in-flight claim of one counts it out, so a pass in progress does not delete one too many', async () => {
      const a = await fresh();
      const all = await estate(a, 21);
      expect((await idleList()).filter((r) => r.account_id === a.accountId).map((r) => r.sandbox_name)).toEqual([all[0]!.name]);
      expect(await claimIdle(all[0]!.name, 'cap')).toBe('claimed');
      expect((await idleList()).filter((r) => r.account_id === a.accountId)).toEqual([]);
      await done(all[0]!.name, 'deleted');
      expect((await idleList()).filter((r) => r.account_id === a.accountId)).toEqual([]);
    });

    it('the idle rule goes first: names idle over 7 days are not counted against the cap', async () => {
      const a = await fresh();
      const young = await estate(a, 20);
      const old = [await sandbox(a, 101, { idleHours: 24 * 9 }), await sandbox(a, 102, { idleHours: 24 * 10 })];
      const listed = (await idleList()).filter((r) => r.account_id === a.accountId);
      expect(listed.map((r) => [r.sandbox_name, r.reason]).sort()).toEqual(old.map((s) => [s.name, 'idle']).sort());
      expect(listed.some((r) => young.some((y) => y.name === r.sandbox_name))).toBe(false);
    });

    it('names a live run, the terminal pass or another account holds do not count; the cap is per account', async () => {
      const a = await fresh();
      const b = await fresh();
      await estate(a, 20);
      await sandbox(a, 201, { idleHours: 1, status: 'running' }); // live: not idle
      await sandbox(a, 202, { idleHours: 1, stage: 'merged' }); // the terminal pass's
      await estate(b, 20);
      expect((await idleList()).filter((r) => r.account_id === a.accountId || r.account_id === b.accountId)).toEqual([]);
      await sandbox(b, 203, { idleHours: 1 });
      expect((await idleList()).filter((r) => r.account_id === a.accountId)).toEqual([]);
      expect((await idleList()).filter((r) => r.account_id === b.accountId)).toHaveLength(1);
    });

    it('the cap argument is the limit: a smaller cap lists more', async () => {
      const a = await fresh();
      await estate(a, 5);
      expect((await idleList(5)).filter((r) => r.account_id === a.accountId)).toEqual([]);
      expect((await idleList(2)).filter((r) => r.account_id === a.accountId)).toHaveLength(3);
    });
  });
});
