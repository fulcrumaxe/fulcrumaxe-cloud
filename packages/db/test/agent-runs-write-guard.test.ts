import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * Security review of #205 (M1, S1, S2) against 0642's write guard.
 *
 * platform_ops owns the definer functions AND is a LOGIN the web handlers
 * connect as, with direct INSERT/UPDATE grants on agent_runs and RLS bound
 * only to the settable app.account_id. Without the guard it could rewrite a
 * genuine needs-fix envelope, insert a `succeeded` row, or walk status
 * succeeded -> pending -> succeeded, and the merge gate would trust the
 * result. Each test below fails on a migration without the matching guard.
 */
const GUARD = /platform_ops may not/;
const KNOWN_STATUSES = [
  'pending', 'refused_spend', 'running', 'succeeded', 'failed', 'timed_out', 'killed_spend', 'paused', 'cancelled',
];
const OWNER_PROBE = 'fx_guard_owner_probe';

describe('agent_runs write guard (0642, security review of #205)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let platformOps: Pool;
  let writerPool: Pool;
  let probe: Pool;
  let refs: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    platformOps = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    writerPool = createPool(process.env.DATABASE_URL_RUN_WRITER!);
    refs = await seedAccount(admin, randomUUID());

    // A stand-in for "the owner / an ops session with full table rights that
    // is NOT the platform_ops login": a non-superuser that bypasses RLS and
    // holds INSERT/UPDATE on agent_runs. The table-level invariants must bind
    // it too (a superuser is the one exemption: it can drop the trigger).
    await admin.query(`DROP ROLE IF EXISTS ${OWNER_PROBE}`);
    await admin.query(`CREATE ROLE ${OWNER_PROBE} LOGIN NOSUPERUSER BYPASSRLS`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE ON agent_runs TO ${OWNER_PROBE}`);
    // 0750: the insert trigger calls a helper only its invokers may execute; this stand-in is one.
    await admin.query(`GRANT EXECUTE ON FUNCTION work_item_halt_lock(uuid, uuid) TO ${OWNER_PROBE}`);
    const u = new URL(process.env.DATABASE_URL!);
    u.username = OWNER_PROBE;
    u.password = '';
    probe = createPool(u.toString());
  });

  afterAll(async () => {
    await probe.end();
    await admin.query(`REVOKE ALL ON agent_runs FROM ${OWNER_PROBE}`);
    await admin.query(`REVOKE EXECUTE ON FUNCTION work_item_halt_lock(uuid, uuid) FROM ${OWNER_PROBE}`);
    await admin.query(`DROP ROLE ${OWNER_PROBE}`);
    admin.release();
    await adminPool.end();
    await platformOps.end();
    await writerPool.end();
  });

  /** A distinct head per fixture row: 0643 allows one live reviewer run per
   * (work item, head, role), and these rows are not about that rule. */
  const uniqueSha = (): string => randomUUID().replaceAll('-', '').padEnd(40, '0');

  /** A row placed by the superuser fixture (exempt from the table invariants). */
  async function fixture(status: string, envelope: unknown = null): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, envelope, head_sha)
       VALUES ($1, $2, $3, 'code-reviewer', 'production', $4, $5::jsonb, $6)`,
      [id, refs.accountId, refs.workItemId, status, envelope === null ? null : JSON.stringify(envelope), uniqueSha()],
    );
    return id;
  }

  async function row(id: string): Promise<{ status: string; envelope: unknown; cc_session_id: string | null }> {
    const { rows } = await admin.query(`SELECT status, envelope, cc_session_id FROM agent_runs WHERE id = $1`, [id]);
    return rows[0];
  }

  describe('M1(1): a direct platform_ops session cannot forge gate-relevant state', () => {
    const asPlatformOps = (attempt: (c: PoolClient) => Promise<unknown>): Promise<unknown> =>
      withTenant(platformOps, refs.accountId, attempt);

    it('cross-tenant envelope rewrite (needs-fix -> pass) is refused and changes nothing', async () => {
      const id = await fixture('succeeded', { verdict: 'needs-fix' });
      await expect(
        asPlatformOps((c) => c.query(`UPDATE agent_runs SET envelope = '{"verdict":"pass"}' WHERE id = $1`, [id])),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE, message: expect.stringMatching(GUARD) });
      expect((await row(id)).envelope).toEqual({ verdict: 'needs-fix' });
    });

    it('a direct INSERT is refused whatever its status', async () => {
      for (const status of ['succeeded', 'pending']) {
        await expect(
          asPlatformOps((c) =>
            c.query(
              `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, head_sha)
               VALUES ($1, $2, $3, 'security-reviewer', 'production', $4, $5)`,
              [randomUUID(), refs.accountId, refs.workItemId, status, 'b'.repeat(40)],
            ),
          ),
          status,
        ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE, message: expect.stringMatching(GUARD) });
      }
    });

    it('status succeeded -> pending -> succeeded is refused at the first hop; cc_session_id is guarded too', async () => {
      const id = await fixture('succeeded', { verdict: 'needs-fix' });
      for (const set of [`status = 'pending'`, `status = 'running'`, `cc_session_id = 'x'`]) {
        await expect(
          asPlatformOps((c) => c.query(`UPDATE agent_runs SET ${set} WHERE id = $1`, [id])),
          set,
        ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE, message: expect.stringMatching(GUARD) });
      }
      expect(await row(id)).toMatchObject({ status: 'succeeded', cc_session_id: null });
    });

    it('is not over-broad: a metering-only UPDATE by platform_ops still works', async () => {
      const id = await fixture('running');
      await asPlatformOps((c) => c.query(`UPDATE agent_runs SET tokens_out = 5 WHERE id = $1`, [id]));
      const { rows } = await admin.query(`SELECT tokens_out FROM agent_runs WHERE id = $1`, [id]);
      expect(rows[0].tokens_out).toBe('5');
    });

    it('the trigger reads no table the definer\'s owner cannot: the writer keeps working once plpgsql switches to generic plans (8+ calls)', async () => {
      // plpgsql caches plans and moves to a generic one after five
      // executions; a permission check on a table platform_ops cannot read
      // (work_items) showed up only from the sixth call on, in a review run.
      for (let i = 0; i < 8; i++) {
        const id = randomUUID();
        await withTenant(writerPool, refs.accountId, async (c) => {
          await c.query(
            `SELECT agent_run_create($1::uuid, $2::uuid, $3::uuid, NULL, 'code-reviewer', 'production', $4, NULL, NULL, NULL, NULL, jsonb_build_object('accountId', $2::uuid::text), repeat('a', 64))`,
            [id, refs.accountId, refs.workItemId, 'f'.repeat(40)],
          );
          await c.query(`SELECT agent_run_set_status($1::uuid, $2::uuid, 'pending', 'running', NULL, NULL, NULL, NULL, NULL)`, [
            refs.accountId,
            id,
          ]);
          await c.query(
            `SELECT agent_run_set_status($1::uuid, $2::uuid, 'running', 'succeeded', '{"verdict":"pass"}', NULL, NULL, NULL, NULL)`,
            [refs.accountId, id],
          );
        });
        expect((await row(id)).status).toBe('succeeded');
      }
    });

    it('the definer path is unaffected: session_user there is the runner login, so create -> running -> succeeded works', async () => {
      const id = randomUUID();
      await withTenant(writerPool, refs.accountId, async (c) => {
        await c.query(
          `SELECT agent_run_create($1::uuid, $2::uuid, $3::uuid, NULL, 'code-reviewer', 'production', $4, NULL, NULL, NULL, NULL, jsonb_build_object('accountId', $2::uuid::text), repeat('a', 64))`,
          [id, refs.accountId, refs.workItemId, 'c'.repeat(40)],
        );
        const set = `SELECT agent_run_set_status($1::uuid, $2::uuid, $3, $4, $5::jsonb, NULL, NULL, NULL, $6) AS ok`;
        expect((await c.query(set, [refs.accountId, id, 'pending', 'running', null, 'sess'])).rows[0].ok).toBe(true);
        expect(
          (await c.query(set, [refs.accountId, id, 'running', 'succeeded', '{"verdict":"pass"}', null])).rows[0].ok,
        ).toBe(true);
      });
      expect(await row(id)).toMatchObject({ status: 'succeeded', envelope: { verdict: 'pass' }, cc_session_id: 'sess' });
    });
  });

  describe('M1(2): the invariants are enforced on the table, so they bind a non-superuser owner too', () => {
    const check = { code: PG_ERROR.CHECK_VIOLATION };

    it('INSERT must be pending with a NULL envelope', async () => {
      const ins = (status: string, envelope: string | null): Promise<unknown> =>
        probe.query(
          `INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, envelope, head_sha)
           VALUES ($1, $2, 'code-reviewer', 'production', $3, $4::jsonb, $5)`,
          [refs.accountId, refs.workItemId, status, envelope, 'd'.repeat(40)],
        );
      await expect(ins('succeeded', null)).rejects.toMatchObject(check);
      await expect(ins('pending', '{"verdict":"pass"}')).rejects.toMatchObject(check);
      await expect(ins('pending', null)).resolves.toBeDefined(); // control: the legal shape goes through
    });

    it('status moves only along the legal edges', async () => {
      const pending = await fixture('pending');
      await expect(probe.query(`UPDATE agent_runs SET status = 'succeeded' WHERE id = $1`, [pending])).rejects.toMatchObject(check);
      const done = await fixture('succeeded', { verdict: 'needs-fix' });
      for (const to of ['pending', 'running', 'failed']) {
        await expect(probe.query(`UPDATE agent_runs SET status = '${to}' WHERE id = $1`, [done]), to).rejects.toMatchObject(check);
      }
      await probe.query(`UPDATE agent_runs SET status = 'running' WHERE id = $1`, [pending]); // control
      expect((await row(pending)).status).toBe('running');
    });

    it('the envelope is set once, only on a non-terminal -> terminal move', async () => {
      const running = await fixture('running');
      // Not on a move to a non-terminal status, and not without a move.
      await expect(probe.query(`UPDATE agent_runs SET envelope = '{"verdict":"pass"}' WHERE id = $1`, [running])).rejects.toMatchObject(check);
      const pending = await fixture('pending');
      await expect(
        probe.query(`UPDATE agent_runs SET status = 'running', envelope = '{"verdict":"pass"}' WHERE id = $1`, [pending]),
      ).rejects.toMatchObject(check);
      // In the same statement as the terminal move: allowed (control) ...
      await probe.query(`UPDATE agent_runs SET status = 'succeeded', envelope = '{"verdict":"needs-fix"}' WHERE id = $1`, [running]);
      expect((await row(running)).envelope).toEqual({ verdict: 'needs-fix' });
      // ... and never again, whether or not the status moves.
      await expect(probe.query(`UPDATE agent_runs SET envelope = '{"verdict":"pass"}' WHERE id = $1`, [running])).rejects.toMatchObject(check);
      await expect(probe.query(`UPDATE agent_runs SET envelope = NULL WHERE id = $1`, [running])).rejects.toMatchObject(check);
      // A terminal move made first cannot be followed by a later envelope.
      const bare = await fixture('running');
      await probe.query(`UPDATE agent_runs SET status = 'failed' WHERE id = $1`, [bare]);
      await expect(probe.query(`UPDATE agent_runs SET envelope = '{"verdict":"pass"}' WHERE id = $1`, [bare])).rejects.toMatchObject(check);
      expect((await row(running)).envelope).toEqual({ verdict: 'needs-fix' });
    });
  });

  describe('S1: the ON DELETE SET NULL carve-out needs the parent to be gone', () => {
    it('a nested UPDATE to NULL of work_item_id / spec_version_id while the parent still exists is refused (42501)', async () => {
      const t = await seedAccount(admin, randomUUID());
      const body = 'spec';
      const specId = randomUUID();
      await admin.query(
        `INSERT INTO spec_versions (id, account_id, work_item_id, version, body, body_sha256, created_by_kind)
         VALUES ($1, $2, $3, 1, $4, $5, 'user')`,
        [specId, t.accountId, t.workItemId, body, createHash('sha256').update(body).digest('hex')],
      );
      const runId = randomUUID();
      await admin.query(
        `INSERT INTO agent_runs (id, account_id, work_item_id, spec_version_id, role, runtime, status, head_sha)
         VALUES ($1, $2, $3, $4, 'code-reviewer', 'production', 'pending', $5)`,
        [runId, t.accountId, t.workItemId, specId, 'e'.repeat(40)],
      );
      // An owner-created trigger that nests the UPDATE (pg_trigger_depth() = 2).
      await admin.query(`CREATE TABLE guard_scratch_nest (col text)`);
      await admin.query(`
        CREATE FUNCTION guard_scratch_nest_fn() RETURNS trigger LANGUAGE plpgsql AS $f$
        BEGIN
          EXECUTE format('UPDATE agent_runs SET %I = NULL WHERE id = %L', NEW.col, '${runId}');
          RETURN NEW;
        END $f$`);
      await admin.query(
        `CREATE TRIGGER guard_scratch_nest_t AFTER INSERT ON guard_scratch_nest FOR EACH ROW EXECUTE FUNCTION guard_scratch_nest_fn()`,
      );
      try {
        for (const col of ['work_item_id', 'spec_version_id']) {
          await expect(admin.query(`INSERT INTO guard_scratch_nest VALUES ($1)`, [col]), col).rejects.toMatchObject({
            code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
          });
        }
        const { rows } = await admin.query(`SELECT work_item_id, spec_version_id FROM agent_runs WHERE id = $1`, [runId]);
        expect(rows[0]).toEqual({ work_item_id: t.workItemId, spec_version_id: specId });

        // The real RI action still works once the parent is deleted (the
        // work item's delete cascades to the spec version as well).
        await admin.query(`DELETE FROM work_items WHERE id = $1`, [t.workItemId]);
        const after = await admin.query(`SELECT work_item_id, spec_version_id FROM agent_runs WHERE id = $1`, [runId]);
        expect(after.rows[0]).toEqual({ work_item_id: null, spec_version_id: null });
      } finally {
        await admin.query(`DROP TABLE guard_scratch_nest`);
        await admin.query(`DROP FUNCTION guard_scratch_nest_fn()`);
      }
    });
  });

  describe('S2: agent_runs.status has a CHECK on the known vocabulary', () => {
    it('all nine known statuses are accepted and anything else is refused (23514), even for the superuser', async () => {
      for (const s of KNOWN_STATUSES) await fixture(s);
      await expect(fixture('bogus')).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      const id = await fixture('pending');
      await expect(admin.query(`UPDATE agent_runs SET status = 'bogus' WHERE id = $1`, [id])).rejects.toMatchObject({
        code: PG_ERROR.CHECK_VIOLATION,
      });
      const { rows } = await admin.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'agent_runs'::regclass AND conname = 'agent_runs_status_known'`,
      );
      const listed = [...String(rows[0].def).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
      expect(listed).toEqual([...KNOWN_STATUSES].sort());
    });
  });
});
