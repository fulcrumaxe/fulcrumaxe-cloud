import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#598 P1f-5r (0872): the reaper and the bookkeeping learn "pp-<publish attempt id>". Real Postgres, real roles. The 1-day net lists a
 * publish sandbox a finished run row explains; the status lookup answers from the attempt row; the runner's name mark and the other name
 * checks accept the shape and still refuse anything else.
 */
describe('publish sandboxes in the reaper and the bookkeeping (0872)', () => {
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

  const DIGEST = 'a'.repeat(64);
  const fresh = () => seedAccount(admin, randomUUID());
  const status = async (a: SeedRefs, name: string) => (await writerPool.query(`SELECT sandbox_reap_publish_status($1, $2) AS v`, [a.accountId, name])).rows[0].v as string;
  const list = async () => (await writerPool.query(`SELECT * FROM sandbox_reap_candidates_ephemeral(50, NULL)`)).rows as { account_id: string; sandbox_name: string; reason: string }[];
  const claim = async (name: string) => (await writerPool.query(`SELECT sandbox_reap_claim_ephemeral($1) AS v`, [name])).rows[0].v as string;

  async function push(a: SeedRefs): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO plane_pushes (account_id, work_item_id, repo_id, code_repo, pairing_digest) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [a.accountId, a.workItemId, a.repoId, `acme-${randomUUID().slice(0, 8)}/widgets-public`, DIGEST],
    );
    return rows[0]!.id;
  }

  interface Opts {
    runStatus?: string | null; // null: no run row at all
    attempt?: 'none' | 'unfinished' | 'finished';
    endedHoursAgo?: number;
    ledger?: boolean;
    attemptAge?: string;
  }
  /** A publish sandbox: the attempt row's id names it, the run row records the name. Ended 25 hours ago and settled by default. */
  async function publish(a: SeedRefs, o: Opts = {}): Promise<{ name: string; attemptId: string; runId: string | null }> {
    const attemptId = randomUUID();
    const name = `pp-${attemptId}`;
    let runId: string | null = null;
    if (o.runStatus !== null) {
      runId = randomUUID();
      await admin.query(
        `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, sandbox_name, dispatch_repo_id, created_at)
         VALUES ($1, $2, $3, 'plane_publish', 'production', $4, $5, $6, now() - interval '30 hours')`,
        [runId, a.accountId, a.workItemId, o.runStatus ?? 'succeeded', name, a.repoId],
      );
      await admin.query(`ALTER TABLE agent_runs DISABLE TRIGGER USER`);
      try {
        await admin.query(`UPDATE agent_runs SET ended_at = now() - make_interval(hours => $2::int) WHERE id = $1`, [runId, o.endedHoursAgo ?? 25]);
      } finally {
        await admin.query(`ALTER TABLE agent_runs ENABLE TRIGGER USER`);
      }
      if (o.ledger !== false) await admin.query(`INSERT INTO ledger (account_id, kind, source, usd, run_id, budget) VALUES ($1, 'compute', 'sandbox', 0.1, $2, 'foreground_compute')`, [a.accountId, runId]);
    }
    if ((o.attempt ?? 'finished') !== 'none') {
      const p = await push(a);
      await admin.query(
        `INSERT INTO plane_push_attempts (id, account_id, plane_push_id, run_id, runtime, kind, attempt_no, finished_at, created_at)
         VALUES ($1, $2, $3, $4, 'sandbox', 'push', 1, CASE WHEN $5 THEN now() ELSE NULL END, now() - $6::interval)`,
        [attemptId, a.accountId, p, runId, (o.attempt ?? 'finished') === 'finished', o.attemptAge ?? '2 hours'],
      );
    }
    return { name, attemptId, runId };
  }

  describe('the status lookup, from the attempt row', () => {
    it('a finished attempt is terminal; an unfinished one whose run has ended is terminal too (a crash leaves finished_at null)', async () => {
      const a = await fresh();
      expect(await status(a, (await publish(a, { attempt: 'finished' })).name)).toBe('terminal');
      expect(await status(a, (await publish(a, { attempt: 'unfinished', runStatus: 'failed' })).name)).toBe('terminal');
    });

    it('an unfinished attempt with a live run is live; so is a live run with no attempt row', async () => {
      const a = await fresh();
      for (const s of ['pending', 'running', 'paused']) {
        expect(await status(a, (await publish(a, { attempt: 'unfinished', runStatus: s })).name), s).toBe('live');
      }
      expect(await status(a, (await publish(a, { attempt: 'none', runStatus: 'running' })).name)).toBe('live');
    });

    it('a young unfinished attempt with no run yet is live; an old one with no run is terminal', async () => {
      const a = await fresh();
      expect(await status(a, (await publish(a, { attempt: 'unfinished', runStatus: null, attemptAge: '5 minutes' })).name)).toBe('live');
      expect(await status(a, (await publish(a, { attempt: 'unfinished', runStatus: null, attemptAge: '3 hours' })).name)).toBe('terminal');
    });

    it('a name with no attempt row and no run row anywhere is an orphan', async () => {
      const a = await fresh();
      expect(await status(a, `pp-${randomUUID()}`)).toBe('orphan');
    });

    it('is derived on every call: a live attempt turns terminal the moment it is finished', async () => {
      const a = await fresh();
      const p = await publish(a, { attempt: 'unfinished', runStatus: 'running' });
      expect(await status(a, p.name)).toBe('live');
      await admin.query(`UPDATE agent_runs SET status = 'succeeded' WHERE id = $1`, [p.runId]);
      await admin.query(`UPDATE plane_push_attempts SET finished_at = now() WHERE id = $1`, [p.attemptId]);
      expect(await status(a, p.name)).toBe('terminal');
    });

    it('cross-account: another account\'s name answers refused for the wrong caller, whatever state it is in, and its own account still sees the truth', async () => {
      const a = await fresh();
      const b = await fresh();
      const live = await publish(a, { attempt: 'unfinished', runStatus: 'running' });
      const done = await publish(a, { attempt: 'finished' });
      const runOnly = await publish(a, { attempt: 'none', runStatus: 'succeeded' });
      for (const p of [live, done, runOnly]) {
        expect(await status(b, p.name)).toBe('refused');
      }
      expect(await status(a, live.name)).toBe('live');
      expect(await status(a, done.name)).toBe('terminal');
    });

    it('refuses a bad name or a null argument, and only the runner login\'s role may call it', async () => {
      const a = await fresh();
      for (const bad of ['pp-x', 'pp-', 'ex-1', 'rn-1-x-1', `PP-${randomUUID()}`, `pp-${randomUUID()}x`, `pp-${randomUUID().toUpperCase()}`]) {
        await expect(writerPool.query(`SELECT sandbox_reap_publish_status($1, $2)`, [a.accountId, bad]), bad).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      }
      await expect(writerPool.query(`SELECT sandbox_reap_publish_status(NULL, $1)`, [`pp-${randomUUID()}`])).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      const sql = `SELECT sandbox_reap_publish_status('${a.accountId}', 'pp-${randomUUID()}')`;
      await expect(appPool.query(sql)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(withTenant(appPool, a.accountId, (c) => c.query(sql))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(opsPool.query(sql)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('the lookup\'s role holds exactly the columns the body reads and is NOLOGIN with no members', async () => {
      const held = await admin.query(
        `SELECT table_name || '.' || column_name || ' ' || privilege_type AS p FROM information_schema.column_privileges WHERE grantee = 'sandbox_publish_reaper' ORDER BY 1`,
      );
      expect(held.rows.map((r: { p: string }) => r.p)).toEqual([
        ...['account_id', 'id', 'sandbox_name', 'status'].map((c) => `agent_runs.${c} SELECT`),
        ...['account_id', 'created_at', 'finished_at', 'id', 'run_id'].map((c) => `plane_push_attempts.${c} SELECT`),
      ].sort());
      const role = await admin.query(`SELECT rolcanlogin, rolsuper, rolbypassrls, (SELECT count(*) FROM pg_auth_members WHERE roleid = r.oid) AS members FROM pg_roles r WHERE rolname = 'sandbox_publish_reaper'`);
      expect(role.rows).toEqual([{ rolcanlogin: false, rolsuper: false, rolbypassrls: false, members: '0' }]);
    });
  });

  describe('the 1-day net lists a publish sandbox its run row explains', () => {
    it('a terminal pp- sandbox is a candidate, claimable once; a record can be written for it', async () => {
      const a = await fresh();
      const p = await publish(a, { attempt: 'finished' });
      expect((await list()).find((r) => r.sandbox_name === p.name)).toMatchObject({ account_id: a.accountId, reason: 'ephemeral' });
      expect(await claim(p.name)).toBe('claimed');
      expect(await claim(p.name)).toBe('refused_claimed');
      await writerPool.query(`SELECT sandbox_reap_done($1, 'deleted')`, [p.name]);
      expect((await admin.query(`SELECT state, account_id FROM sandbox_reaps WHERE sandbox_name = $1`, [p.name])).rows).toEqual([{ state: 'deleted', account_id: a.accountId }]);
    });

    it('a pp- sandbox whose run row has no attempt row is reaped the same way, and the lookup calls it an orphan', async () => {
      const a = await fresh();
      const p = await publish(a, { attempt: 'none', runStatus: 'failed' });
      expect(await status(a, p.name)).toBe('orphan');
      expect((await list()).map((r) => r.sandbox_name)).toContain(p.name);
      expect(await claim(p.name)).toBe('claimed');
    });

    it('a live pp- sandbox is neither listed nor claimable; a young one is not claimable either', async () => {
      const a = await fresh();
      const live = await publish(a, { attempt: 'unfinished', runStatus: 'running' });
      const young = await publish(a, { attempt: 'finished', endedHoursAgo: 1 });
      const names = (await list()).map((r) => r.sandbox_name);
      expect(names).not.toContain(live.name);
      expect(names).not.toContain(young.name);
      expect(await claim(live.name)).toBe('refused_live');
      expect(await claim(young.name)).toBe('refused_young');
    });

    it('a pp- sandbox whose compute is not settled is listed as unsettled and never claimed', async () => {
      const a = await fresh();
      const p = await publish(a, { attempt: 'finished', ledger: false });
      expect((await list()).find((r) => r.sandbox_name === p.name)?.reason).toBe('ephemeral_unsettled');
      expect(await claim(p.name)).toBe('refused_unsettled');
    });

    it('cross-account: a name that runs of two accounts record belongs to neither and is not reaped', async () => {
      const a = await fresh();
      const b = await fresh();
      const p = await publish(a, { attempt: 'finished' });
      await admin.query(
        `INSERT INTO agent_runs (id, account_id, role, runtime, status, sandbox_name, created_at) VALUES ($1, $2, 'plane_publish', 'production', 'succeeded', $3, now() - interval '30 hours')`,
        [randomUUID(), b.accountId, p.name],
      );
      expect((await list()).map((r) => r.sandbox_name)).not.toContain(p.name);
      expect(await claim(p.name)).toBe('refused_not_candidate');
      expect(await status(b, p.name)).toBe('refused');
    });
  });

  describe('the name checks', () => {
    it('an unknown prefix still raises everywhere; pp- is accepted', async () => {
      const raising = [
        `SELECT sandbox_reap_unknown_names(ARRAY['zz-1'])`,
        `SELECT sandbox_reap_unknown_names(ARRAY['rlr0-1'])`,
        `SELECT * FROM sandbox_reap_candidates_ephemeral(5, 'zz-x')`,
        `SELECT * FROM sandbox_reap_candidates_ephemeral(5, 'ex-x')`,
        `SELECT sandbox_reap_claim_ephemeral('zz-1')`,
        `SELECT sandbox_reap_claim_ephemeral('ex-1-2-3')`,
        `SELECT * FROM sandbox_inventory_write(ARRAY['zz-1'], ARRAY['live'], 20)`,
      ];
      for (const sql of raising) await expect(writerPool.query(sql), sql).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      const unknown = `pp-${randomUUID()}`;
      expect((await writerPool.query(`SELECT sandbox_reap_unknown_names(ARRAY[$1]::text[]) AS v`, [unknown])).rows[0].v).toEqual([unknown]);
      const a = await fresh();
      const known = await publish(a, { attempt: 'finished' });
      expect((await writerPool.query(`SELECT sandbox_reap_unknown_names(ARRAY[$1]::text[]) AS v`, [known.name])).rows[0].v).toEqual([]);
      await expect(writerPool.query(`SELECT * FROM sandbox_reap_candidates_ephemeral(5, $1)`, [`pp-${randomUUID()}`])).resolves.toBeTruthy();
    });

    it('the inventory counts a pp- sandbox for the account whose run row owns it, as ephemeral, and an unowned one as an orphan', async () => {
      const a = await fresh();
      const owned = await publish(a, { attempt: 'finished' });
      const stray = `pp-${randomUUID()}`;
      const { rows } = await writerPool.query(`SELECT * FROM sandbox_inventory_write(ARRAY[$1, $2]::text[], ARRAY['stopped', 'stopped'], 20)`, [owned.name, stray]);
      expect(rows[0]).toMatchObject({ orphans: 1 });
      expect((await admin.query(`SELECT live, stopped_executor, stopped_ephemeral, idle_executor FROM sandbox_inventory WHERE account_id = $1`, [a.accountId])).rows).toEqual([
        { live: 0, stopped_executor: 0, stopped_ephemeral: 1, idle_executor: 0 },
      ]);
    });

    it('sandbox_reaps takes a pp- name and still refuses another prefix', async () => {
      const a = await fresh();
      const ok = `INSERT INTO sandbox_reaps (sandbox_name, account_id, run_id, reason, state) VALUES ('pp-${randomUUID()}', '${a.accountId}', '${randomUUID()}', 'ephemeral', 'claimed')`;
      await admin.query(ok);
      await expect(admin.query(ok.replace("'pp-", "'zz-"))).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });

    const MARK = `SELECT agent_run_sandbox_mark($1::uuid, $2::uuid, false, NULL, false, NULL, NULL, $3::text)`;
    const markName = async (a: SeedRefs, runId: string, name: string) => withTenant(writerPool, a.accountId, (c) => c.query(MARK, [a.accountId, runId, name]));
    const newRun = async (a: SeedRefs) => {
      const id = randomUUID();
      await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1, $2, 'plane_publish', 'production', 'running')`, [id, a.accountId]);
      return id;
    };
    const recorded = async (id: string) => (await admin.query(`SELECT sandbox_name FROM agent_runs WHERE id = $1 /* agent-run-columns: allow admin connection, not app_user */`, [id])).rows[0].sandbox_name as string | null;

    it('the name mark accepts pp-<uuid>, records it once, and refuses a pp- name of any other shape and any other prefix', async () => {
      const a = await fresh();
      const good = await newRun(a);
      const name = `pp-${randomUUID()}`;
      await markName(a, good, name);
      expect(await recorded(good)).toBe(name);
      await markName(a, good, `pp-${randomUUID()}`); // first wins: a second name leaves the stored one
      expect(await recorded(good)).toBe(name);
      for (const bad of ['pp-', 'pp-abc', `pp-${randomUUID()}-x`, `pp-${randomUUID().toUpperCase()}`, `zz-${randomUUID()}`, `PP-${randomUUID()}`, 'garbage']) {
        const run = await newRun(a);
        await expect(markName(a, run, bad), bad).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
        expect(await recorded(run)).toBeNull();
      }
    });

    it('the name mark still binds ex- and rn- names to their run and account', async () => {
      const a = await fresh();
      const b = await fresh();
      const run = await newRun(a);
      await expect(markName(a, run, `rn-1-x-${randomUUID()}`)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(markName(a, run, `ex-${b.accountId}-${randomUUID()}-1`)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await markName(a, run, `rn-1-x-${run}`);
      expect(await recorded(run)).toBe(`rn-1-x-${run}`);
    });
  });
});
