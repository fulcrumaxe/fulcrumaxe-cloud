import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#2 H13c (correction C27), H13c-1: migration
 * packages/db/migrations/0619_gh_proxy_run_resolution.sql (fix round 1:
 * renumbered from 0614 -- main moved past that number, see the
 * migration's own header) grants `platform_ops` column-scoped SELECT on
 * `agent_runs` and extends its existing (0613) `repos` grant -- exactly
 * the columns packages/github/src/runResolver.ts's query reads, nothing
 * else.
 *
 * Failing-first: before this migration, `agent_runs` had no platform_ops
 * policy or grant at all (0001_core.sql only grants `tenant_isolation`
 * TO app_user; see runResolver.ts's own header for why platform_ops
 * needs read access here in the first place -- there is no tenant to
 * scope a `withTenant` connection by until AFTER the sandbox is
 * resolved).
 */
describe('migration 0619 (fix round 1, was 0614): platform_ops read on agent_runs, extended repos grant (D#2 H13c)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let platformOpsPool: Pool;
  let refs: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    platformOpsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    refs = await seedAccount(admin, randomUUID());
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await platformOpsPool.end();
  });

  // dispatch_repo_id is write-once (0605's agent_runs_dispatch_identity_write_once
  // trigger fires for ANY role, including a superuser admin connection) --
  // set at INSERT time, on a fresh row, never via UPDATE on refs.runId's
  // already-seeded row.
  let resolvableRunId: string;
  let sandboxName: string;

  beforeAll(async () => {
    resolvableRunId = randomUUID();
    sandboxName = `sbx-${randomUUID()}`;
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, role, runtime, status, sandbox_name, dispatch_repo_id)
       VALUES ($1, $2, 'executor', 'production', 'running', $3, $4)`,
      [resolvableRunId, refs.accountId, sandboxName, refs.repoId],
    );
    await admin.query(`UPDATE repos SET gh_owner = 'acme-corp', gh_name = 'widgets' WHERE id = $1`, [refs.repoId]);
  });

  it('platform_ops can run exactly the resolver query (account_id/role/status/sandbox_name/dispatch_repo_id on agent_runs, joined through repos/installations)', async () => {
    const { rows } = await platformOpsPool.query(
      `SELECT ar.role, ar.status, r.product, r.gh_owner, r.gh_name, i.gh_installation_id
         FROM agent_runs ar
         JOIN repos r ON r.id = ar.dispatch_repo_id AND r.account_id = ar.account_id
         JOIN installations i ON i.id = r.installation_id AND i.account_id = r.account_id
        WHERE ar.sandbox_name = $1`,
      [sandboxName],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: 'executor', status: 'running', gh_owner: 'acme-corp', gh_name: 'widgets' });
  });

  it('platform_ops gets permission denied reading agent_runs.envelope (a column outside the grant)', async () => {
    await expect(platformOpsPool.query(`SELECT envelope FROM agent_runs WHERE id = $1`, [resolvableRunId])).rejects.toMatchObject({
      code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
    });
  });

  it('platform_ops gets permission denied reading other ungranted agent_runs columns (tokens_in, usd, cc_session_id)', async () => {
    for (const column of ['tokens_in', 'usd', 'cc_session_id']) {
      await expect(platformOpsPool.query(`SELECT ${column} FROM agent_runs WHERE id = $1`, [resolvableRunId])).rejects.toMatchObject({
        code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
      });
    }
  });

  // D#2 H09c (0642) narrowed this from "cannot write agent_runs at all":
  // platform_ops now OWNS the agent_run_create/agent_run_set_status definer
  // functions, so it holds column-scoped INSERT/UPDATE plus tenant-scoped
  // policies. It still has no privilege on any gate-relevant column that
  // the writer does not itself set, and no RLS path outside a tenant context.
  it('platform_ops cannot touch a row outside a tenant context (0642 policies require app.account_id), and cannot write gate columns the writer never sets', async () => {
    const noContext = await platformOpsPool.query(`UPDATE agent_runs SET status = 'cancelled' WHERE id = $1`, [resolvableRunId]);
    expect(noContext.rowCount).toBe(0);
    for (const column of ['head_sha', 'role', 'runtime', 'created_at', 'account_id', 'work_item_id']) {
      await expect(
        platformOpsPool.query(`UPDATE agent_runs SET ${column} = ${column} WHERE id = $1`, [resolvableRunId]),
        column,
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    }
    await expect(
      platformOpsPool.query(
        `INSERT INTO agent_runs (id, account_id, role, runtime, status, created_at) VALUES ($1, $2, 'x', 'local', 'pending', now())`,
        [randomUUID(), refs.accountId],
      ),
    ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
  });

  it('the platform_ops column-privilege set on agent_runs is exactly the resolver-read columns (plus `id`, which the 0642 writer functions filter on, and `work_item_id`, which claim_funding_for_run in 0664 joins on), and repos gained exactly the four new ones', async () => {
    const { rows: agentRunsCols } = await admin.query(
      `SELECT column_name FROM information_schema.column_privileges
        WHERE grantee = 'platform_ops' AND table_name = 'agent_runs' AND privilege_type = 'SELECT'
        ORDER BY column_name`,
    );
    expect(agentRunsCols.map((r: { column_name: string }) => r.column_name)).toEqual(
      [
        'account_id', 'dispatch_repo_id', 'id', 'role', 'sandbox_name', 'status', 'work_item_id',
        // 0689: the definer agent_run_sandbox_mark reads the five columns it writes (and nothing else new).
        'sandbox_requested_at', 'sandbox_session_ids', 'sandbox_stopped_at', 'sandbox_self_measured', 'compute_settle_due_at',
        // 0691: the definer compute_settle_list_due returns the PR number that names an executor's sandbox.
        'dispatch_pr_number',
        // 0694: the definer agent_run_settle_failed writes these two and the lister reads them for the backoff.
        'compute_settle_failures', 'compute_settle_retry_at',
        // 0714: the definer agent_run_set_runner_job filters on the run's runtime and mode. Not job_signed: the signed job
        // carries task text, so platform_ops (the proxy's login) can write that column and never read it.
        'runtime', 'execution_mode',
        // 0734: the definer agent_run_list_pending_runner_runs orders the waiting runner runs by when they were created.
        'created_at',
      ].sort(),
    );

    const { rows: reposCols } = await admin.query(
      `SELECT column_name FROM information_schema.column_privileges
        WHERE grantee = 'platform_ops' AND table_name = 'repos' AND privilege_type = 'SELECT'
        ORDER BY column_name`,
    );
    // 0613's own three (id, account_id, gh_repo_id) plus 0619's four
    // (gh_name, gh_owner, installation_id, product).
    expect(reposCols.map((r: { column_name: string }) => r.column_name)).toEqual(
      ['account_id', 'gh_name', 'gh_owner', 'gh_repo_id', 'id', 'installation_id', 'product'].sort(),
    );
  });

  it('app_user is unaffected: it can still SELECT envelope directly (0642 removed its writes, not its reads)', async () => {
    const appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    try {
      await expect(
        withTenant(appUserPool, refs.accountId, (client) => client.query(`SELECT envelope FROM agent_runs WHERE id = $1`, [resolvableRunId])),
      ).resolves.toBeDefined();
    } finally {
      await appUserPool.end();
    }
  });
});
