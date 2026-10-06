import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { findRlsViolations } from '../src/rlsInventory.js';

/**
 * D#45 S2 criteria 1-5: the two KPI views, their columns, computed values,
 * tenant isolation and supporting indexes.
 *
 * Six work items, one tenant, cover: a bare `triaged` item with no
 * transitions; a `discussing -> spec_ready` item with no verdict; a full
 * pipeline with TWO reviewers (`code` then `security`) and the C1
 * `needs_human -> discussing` re-spec edge; a `review_passed ->
 * review_passed` SELF-LOOP ending in `merged`; a `pr_opened ->
 * closed_unmerged` abandonment; and a `closed -> triaged` REOPEN (C1)
 * that re-enters `discussing`. Ledger rows cover both kinds (`model` and
 * `compute`), and one run has NULL `tokens_in`/`tokens_out` to prove the
 * view treats that as 0, not NULL.
 */
describe('KPI views (D#45 S2)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let partnerUserPool: Pool;
  let platformOpsPool: Pool;
  let refsA: SeedRefs;
  let refsB: SeedRefs;

  const item = {
    triaged: randomUUID(),
    specReady: randomUUID(),
    pipeline: randomUUID(),
    selfLoop: randomUUID(),
    abandoned: randomUUID(),
    reopened: randomUUID(),
  };
  const run = { pipeline: randomUUID(), selfLoop: randomUUID(), abandoned: randomUUID() };

  const d = (s: string) => new Date(s);

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    partnerUserPool = createPool(process.env.DATABASE_URL_PARTNER_USER!);
    platformOpsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);

    refsA = await seedAccount(admin, randomUUID());
    refsB = await seedAccount(admin, randomUUID());
    // seedAccount leaves one baseline work_item/agent_run/ledger row per
    // tenant; this suite wants an exact, hand-picked set instead. Deleting
    // work_items cascades its transitions; deleting agent_runs separately
    // (FK is ON DELETE SET NULL, not CASCADE, from work_items) removes the
    // baseline run so it can't leak into v_kpi_runs' row counts.
    for (const accountId of [refsA.accountId, refsB.accountId]) {
      await admin.query('DELETE FROM agent_runs WHERE account_id = $1', [accountId]);
      await admin.query('DELETE FROM work_items WHERE account_id = $1', [accountId]);
    }

    await seedFixture(refsA, item, run);
    // Tenant B: a smaller, independent fixture, for the isolation test.
    await seedFixture(refsB, {
      triaged: randomUUID(),
      specReady: randomUUID(),
      pipeline: randomUUID(),
      selfLoop: randomUUID(),
      abandoned: randomUUID(),
      reopened: randomUUID(),
    }, { pipeline: randomUUID(), selfLoop: randomUUID(), abandoned: randomUUID() });
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await partnerUserPool.end();
    await platformOpsPool.end();
  });

  /** Seeds the 6-item fixture described in this suite's header, for one tenant. */
  async function seedFixture(
    refs: SeedRefs,
    ids: typeof item,
    runIds: typeof run,
  ): Promise<void> {
    const wi = async (id: string, createdAt: Date, stage: string) =>
      admin.query(
        `INSERT INTO work_items (id, account_id, repo_id, kind, provenance, created_at, stage)
         VALUES ($1, $2, $3, 'feature', 'internal', $4, $5)`,
        [id, refs.accountId, refs.repoId, createdAt, stage],
      );
    const tr = async (
      workItemId: string,
      from: string,
      to: string,
      at: Date,
      opts: { reviewer?: string; sourceRef?: string } = {},
    ) =>
      admin.query(
        `INSERT INTO work_item_transitions
           (account_id, work_item_id, from_stage, to_stage, reviewer, at, source, source_ref)
         VALUES ($1, $2, $3, $4, $5, $6, 'control_plane', $7)`,
        [refs.accountId, workItemId, from, to, opts.reviewer ?? null, at, opts.sourceRef ?? randomUUID()],
      );
    const runRow = async (id: string, workItemId: string, opts: {
      role: string;
      runtime: 'local' | 'production';
      status: string;
      tokensIn: number | null;
      tokensOut: number | null;
    }) =>
      admin.query(
        `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, tokens_in, tokens_out)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, refs.accountId, workItemId, opts.role, opts.runtime, opts.status, opts.tokensIn, opts.tokensOut],
      );
    // D#2 #171 recheck (SHOULD 3): `budget` has no default tying it to
    // `kind` (`0002_spend_fns.sql`'s `DEFAULT 'model'` is there only so
    // pre-H05 fixtures unaware of `budget` keep working, not as a
    // correct-by-default mapping) -- pass an explicit `budget` matching
    // `kind` rather than leaving a 'compute' row silently defaulted to
    // 'model'.
    const ledgerRow = async (runId: string, kind: 'model' | 'compute', usd: number) =>
      admin.query(
        `INSERT INTO ledger (account_id, kind, source, usd, run_id, budget) VALUES ($1, $2, 'workflow', $3, $4, $5)`,
        [refs.accountId, kind, usd, runId, kind === 'model' ? 'model' : 'foreground_compute'],
      );

    // (1) triaged: no transitions at all.
    await wi(ids.triaged, d('2024-01-01T00:00:00Z'), 'triaged');

    // (2) discussing -> spec_ready, no verdict.
    await wi(ids.specReady, d('2024-01-01T00:00:00Z'), 'spec_ready');
    await tr(ids.specReady, 'triaged', 'discussing', d('2024-01-02T00:00:00Z'));
    await tr(ids.specReady, 'discussing', 'spec_ready', d('2024-01-03T00:00:00Z'));

    // (3) full pipeline: two reviewers, and the C1 needs_human -> discussing
    // re-spec edge, then a second pass through to merged.
    await wi(ids.pipeline, d('2024-01-01T00:00:00Z'), 'merged');
    await tr(ids.pipeline, 'triaged', 'discussing', d('2024-01-01T00:00:00Z'));
    await tr(ids.pipeline, 'discussing', 'spec_ready', d('2024-01-02T00:00:00Z'));
    await tr(ids.pipeline, 'spec_ready', 'in_progress', d('2024-01-03T00:00:00Z'));
    await tr(ids.pipeline, 'in_progress', 'pr_opened', d('2024-01-04T00:00:00Z'));
    await tr(ids.pipeline, 'pr_opened', 'changes_requested', d('2024-01-05T00:00:00Z'), { reviewer: 'code' });
    await tr(ids.pipeline, 'changes_requested', 'needs_human', d('2024-01-06T00:00:00Z'));
    await tr(ids.pipeline, 'needs_human', 'discussing', d('2024-01-07T00:00:00Z'));
    await tr(ids.pipeline, 'discussing', 'spec_ready', d('2024-01-08T00:00:00Z'));
    await tr(ids.pipeline, 'spec_ready', 'in_progress', d('2024-01-09T00:00:00Z'));
    await tr(ids.pipeline, 'in_progress', 'pr_opened', d('2024-01-10T00:00:00Z'));
    await tr(ids.pipeline, 'pr_opened', 'review_passed', d('2024-01-11T00:00:00Z'), { reviewer: 'security' });
    await tr(ids.pipeline, 'review_passed', 'merged', d('2024-01-12T00:00:00Z'));
    await runRow(runIds.pipeline, ids.pipeline, {
      role: 'executor',
      runtime: 'local',
      status: 'succeeded',
      tokensIn: 100,
      tokensOut: 50,
    });
    await ledgerRow(runIds.pipeline, 'model', 1.0);
    await ledgerRow(runIds.pipeline, 'compute', 0.5);

    // (4) self-loop: review_passed -> review_passed, then merged. The run's
    // tokens are both NULL -- the view must treat that as 0.
    await wi(ids.selfLoop, d('2024-01-01T00:00:00Z'), 'merged');
    await tr(ids.selfLoop, 'triaged', 'in_progress', d('2024-01-01T00:00:00Z'));
    await tr(ids.selfLoop, 'in_progress', 'pr_opened', d('2024-01-02T00:00:00Z'));
    await tr(ids.selfLoop, 'pr_opened', 'review_passed', d('2024-01-03T00:00:00Z'), { reviewer: 'security' });
    await tr(ids.selfLoop, 'review_passed', 'review_passed', d('2024-01-04T00:00:00Z'), { reviewer: 'security' });
    await tr(ids.selfLoop, 'review_passed', 'merged', d('2024-01-05T00:00:00Z'));
    await runRow(runIds.selfLoop, ids.selfLoop, {
      role: 'executor',
      runtime: 'production',
      status: 'succeeded',
      tokensIn: null,
      tokensOut: null,
    });

    // (5) abandoned: pr_opened -> closed_unmerged. One compute ledger row,
    // no model row -- model_usd must read 0, not NULL.
    await wi(ids.abandoned, d('2024-01-01T00:00:00Z'), 'closed_unmerged');
    await tr(ids.abandoned, 'triaged', 'in_progress', d('2024-01-01T00:00:00Z'));
    await tr(ids.abandoned, 'in_progress', 'pr_opened', d('2024-01-02T00:00:00Z'));
    await tr(ids.abandoned, 'pr_opened', 'closed_unmerged', d('2024-01-03T00:00:00Z'));
    await runRow(runIds.abandoned, ids.abandoned, {
      role: 'executor',
      runtime: 'local',
      status: 'failed',
      tokensIn: 10,
      tokensOut: 5,
    });
    await ledgerRow(runIds.abandoned, 'compute', 0.2);

    // (6) reopen: closed -> triaged (C1), then discussing again.
    await wi(ids.reopened, d('2024-01-01T00:00:00Z'), 'discussing');
    await tr(ids.reopened, 'triaged', 'closed', d('2024-01-01T00:00:00Z'));
    await tr(ids.reopened, 'closed', 'triaged', d('2024-01-02T00:00:00Z'));
    await tr(ids.reopened, 'triaged', 'discussing', d('2024-01-03T00:00:00Z'));
  }

  describe('view shape (criteria 1, 2, 5)', () => {
    it('both views are security_invoker, granted SELECT to app_user only', async () => {
      for (const view of ['v_kpi_work_items', 'v_kpi_runs']) {
        const { rows } = await admin.query<{ reloptions: string[] | null }>(
          `SELECT reloptions FROM pg_class WHERE oid = $1::regclass`,
          [view],
        );
        expect(rows[0]!.reloptions).toContain('security_invoker=true');

        const app = await admin.query<{ b: boolean }>(
          `SELECT has_table_privilege('app_user', $1, 'SELECT') AS b`,
          [view],
        );
        expect(app.rows[0]!.b).toBe(true);
        const partner = await admin.query<{ b: boolean }>(
          `SELECT has_table_privilege('partner_user', $1, 'SELECT') AS b`,
          [view],
        );
        expect(partner.rows[0]!.b).toBe(false);
        const ops = await admin.query<{ b: boolean }>(
          `SELECT has_table_privilege('platform_ops', $1, 'SELECT') AS b`,
          [view],
        );
        expect(ops.rows[0]!.b).toBe(false);
      }
    });

    it('findRlsViolations returns [] on the migrated schema', async () => {
      expect(await findRlsViolations(admin)).toEqual([]);
    });

    it('v_kpi_work_items has exactly the Spec columns', async () => {
      const { rows } = await admin.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'v_kpi_work_items'`,
      );
      expect(new Set(rows.map((r) => r.column_name))).toEqual(
        new Set([
          'account_id', 'work_item_id', 'repo_id', 'kind', 'stage', 'created_at',
          't_discussing', 't_spec_ready', 't_in_progress', 't_pr_opened',
          't_first_verdict', 'first_verdict_stage', 't_needs_human', 't_merged',
          't_closed_unmerged', 't_closed', 'n_changes_requested', 'n_needs_human',
          'model_usd', 'compute_usd', 'tokens',
        ]),
      );
    });

    it('v_kpi_runs has exactly the Spec columns', async () => {
      const { rows } = await admin.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'v_kpi_runs'`,
      );
      expect(new Set(rows.map((r) => r.column_name))).toEqual(
        new Set([
          'account_id', 'run_id', 'work_item_id', 'repo_id', 'role', 'runtime',
          'status', 'created_at', 'started_at', 'ended_at', 'tokens_in',
          'tokens_out', 'model_usd', 'compute_usd',
        ]),
      );
    });

    it('the runtime filter appears literally in both viewdefs', async () => {
      for (const view of ['v_kpi_work_items', 'v_kpi_runs']) {
        const { rows } = await admin.query<{ def: string }>(`SELECT pg_get_viewdef($1::regclass, true) AS def`, [
          view,
        ]);
        expect(rows[0]!.def).toMatch(/runtime = ANY \(ARRAY\['local'::text, 'production'::text\]\)|runtime IN \('local', 'production'\)/);
      }
    });

    it('the two indexes exist', async () => {
      const { rows } = await admin.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE indexname IN ($1, $2)`,
        ['idx_ledger_account_run', 'idx_agent_runs_account_work_item'],
      );
      expect(new Set(rows.map((r) => r.indexname))).toEqual(
        new Set(['idx_ledger_account_run', 'idx_agent_runs_account_work_item']),
      );
    });
  });

  describe('values (criterion 3)', () => {
    it("matches the hand-computed row for every item", async () => {
      const { rows } = await withTenant(appUserPool, refsA.accountId, (client) =>
        client.query('SELECT * FROM v_kpi_work_items ORDER BY created_at'),
      );
      const byId = new Map(rows.map((r) => [r.work_item_id, r]));

      const row = byId.get(item.triaged)!;
      expect(row.stage).toBe('triaged');
      expect(row.repo_id).toBe(refsA.repoId);
      expect(row.kind).toBe('feature');
      for (const col of [
        't_discussing', 't_spec_ready', 't_in_progress', 't_pr_opened',
        't_first_verdict', 'first_verdict_stage', 't_needs_human', 't_merged',
        't_closed_unmerged', 't_closed',
      ]) {
        expect(row[col]).toBeNull();
      }
      expect(Number(row.n_changes_requested)).toBe(0);
      expect(Number(row.n_needs_human)).toBe(0);
      expect(Number(row.model_usd)).toBe(0);
      expect(Number(row.compute_usd)).toBe(0);
      expect(Number(row.tokens)).toBe(0);

      const specReadyRow = byId.get(item.specReady)!;
      expect(specReadyRow.t_discussing).toEqual(d('2024-01-02T00:00:00Z'));
      expect(specReadyRow.t_spec_ready).toEqual(d('2024-01-03T00:00:00Z'));
      expect(specReadyRow.t_first_verdict).toBeNull();
      expect(specReadyRow.first_verdict_stage).toBeNull();

      const pipelineRow = byId.get(item.pipeline)!;
      expect(pipelineRow.t_discussing).toEqual(d('2024-01-01T00:00:00Z'));
      expect(pipelineRow.t_spec_ready).toEqual(d('2024-01-02T00:00:00Z'));
      expect(pipelineRow.t_in_progress).toEqual(d('2024-01-03T00:00:00Z'));
      expect(pipelineRow.t_pr_opened).toEqual(d('2024-01-04T00:00:00Z'));
      expect(pipelineRow.t_first_verdict).toEqual(d('2024-01-05T00:00:00Z'));
      expect(pipelineRow.first_verdict_stage).toBe('changes_requested');
      expect(pipelineRow.t_needs_human).toEqual(d('2024-01-06T00:00:00Z'));
      expect(pipelineRow.t_merged).toEqual(d('2024-01-12T00:00:00Z'));
      expect(Number(pipelineRow.n_changes_requested)).toBe(1);
      expect(Number(pipelineRow.n_needs_human)).toBe(1);
      expect(Number(pipelineRow.model_usd)).toBe(1.0);
      expect(Number(pipelineRow.compute_usd)).toBe(0.5);
      expect(Number(pipelineRow.tokens)).toBe(150);

      const selfLoopRow = byId.get(item.selfLoop)!;
      expect(selfLoopRow.t_pr_opened).toEqual(d('2024-01-02T00:00:00Z'));
      expect(selfLoopRow.t_first_verdict).toEqual(d('2024-01-03T00:00:00Z'));
      expect(selfLoopRow.first_verdict_stage).toBe('review_passed');
      expect(selfLoopRow.t_merged).toEqual(d('2024-01-05T00:00:00Z'));
      expect(Number(selfLoopRow.n_changes_requested)).toBe(0);
      expect(Number(selfLoopRow.model_usd)).toBe(0);
      expect(Number(selfLoopRow.compute_usd)).toBe(0);
      expect(Number(selfLoopRow.tokens)).toBe(0); // NULL tokens_in/out -> 0

      const abandonedRow = byId.get(item.abandoned)!;
      expect(abandonedRow.t_pr_opened).toEqual(d('2024-01-02T00:00:00Z'));
      expect(abandonedRow.t_closed_unmerged).toEqual(d('2024-01-03T00:00:00Z'));
      expect(abandonedRow.t_first_verdict).toBeNull();
      expect(Number(abandonedRow.model_usd)).toBe(0);
      expect(Number(abandonedRow.compute_usd)).toBe(0.2);
      expect(Number(abandonedRow.tokens)).toBe(15);

      const reopenedRow = byId.get(item.reopened)!;
      expect(reopenedRow.t_closed).toEqual(d('2024-01-01T00:00:00Z'));
      expect(reopenedRow.t_discussing).toEqual(d('2024-01-03T00:00:00Z'));
      expect(reopenedRow.stage).toBe('discussing');
    });

    it('v_kpi_runs matches the hand-computed row for every seeded run', async () => {
      const { rows } = await withTenant(appUserPool, refsA.accountId, (client) =>
        client.query('SELECT * FROM v_kpi_runs ORDER BY created_at'),
      );
      const byId = new Map(rows.map((r) => [r.run_id, r]));
      expect(rows).toHaveLength(3);

      const pipelineRun = byId.get(run.pipeline)!;
      expect(pipelineRun.work_item_id).toBe(item.pipeline);
      expect(pipelineRun.repo_id).toBe(refsA.repoId);
      expect(pipelineRun.role).toBe('executor');
      expect(pipelineRun.runtime).toBe('local');
      expect(pipelineRun.status).toBe('succeeded');
      expect(Number(pipelineRun.tokens_in)).toBe(100);
      expect(Number(pipelineRun.tokens_out)).toBe(50);
      expect(Number(pipelineRun.model_usd)).toBe(1.0);
      expect(Number(pipelineRun.compute_usd)).toBe(0.5);
      // started_at/ended_at are trigger-stamped (never client-settable),
      // so they are checked against real wall-clock tolerance, same
      // convention as work-item-transitions.test.ts's created_at checks.
      expect(pipelineRun.started_at).toBeNull();
      expect(Math.abs(pipelineRun.ended_at.getTime() - Date.now())).toBeLessThan(5000);

      const selfLoopRun = byId.get(run.selfLoop)!;
      expect(selfLoopRun.tokens_in).toBeNull();
      expect(selfLoopRun.tokens_out).toBeNull();
      expect(Number(selfLoopRun.model_usd)).toBe(0);
      expect(Number(selfLoopRun.compute_usd)).toBe(0);

      const abandonedRun = byId.get(run.abandoned)!;
      expect(abandonedRun.status).toBe('failed');
      expect(Number(abandonedRun.compute_usd)).toBe(0.2);
    });
  });

  describe('isolation (criterion 4)', () => {
    it("withTenant(A) sees exactly A's 6 items and 3 runs in both views", async () => {
      const items = await withTenant(appUserPool, refsA.accountId, (client) =>
        client.query('SELECT account_id FROM v_kpi_work_items'),
      );
      expect(items.rows).toHaveLength(6);
      for (const r of items.rows) expect(r.account_id).toBe(refsA.accountId);

      const runs = await withTenant(appUserPool, refsA.accountId, (client) =>
        client.query('SELECT account_id FROM v_kpi_runs'),
      );
      expect(runs.rows).toHaveLength(3);
      for (const r of runs.rows) expect(r.account_id).toBe(refsA.accountId);
    });

    it("withTenant(B) sees exactly B's own 6 items and 3 runs, none of A's", async () => {
      const items = await withTenant(appUserPool, refsB.accountId, (client) =>
        client.query('SELECT account_id FROM v_kpi_work_items'),
      );
      expect(items.rows).toHaveLength(6);
      for (const r of items.rows) expect(r.account_id).toBe(refsB.accountId);
    });
  });
});
