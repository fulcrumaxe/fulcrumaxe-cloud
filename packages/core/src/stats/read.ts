import type { Pool } from 'pg';
import { computeKpis, type InstallationKpiRow, type KpiResults, type RunKpiRow, type WorkItemKpiRow } from '@fx/stats';
import { NotFoundError } from '../tenancy/errors.js';
import type { InstallationAppKind } from '../repos/appKinds.js';
import { withTenant } from '../tenancy/withTenant.js';

/** D#45 S3: this module's own local copy of the ctx principal shape (matches work-items/read.ts's). */
export interface Principal {
  accountId: string;
  userId: string;
}

/** D#45 S3: `(ctx:{pool, principal}, input)`, mirroring work-items/read.ts. */
export interface StatsReadCtx {
  pool: Pool;
  principal: Principal;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * D#45 S3 criterion 7: this file's only `FROM`/`JOIN` targets are
 * `v_kpi_work_items`, `v_kpi_runs`, `installations`, `work_items` and
 * `work_item_transitions` -- a static test in
 * `packages/core/test/pg/stats-read.test.ts` enforces that no other table
 * or view name ever appears here. Numeric/bigint columns come back from
 * `pg` as strings; every one is wrapped in `Number(...)` on the way into
 * `@fx/stats`' typed row shapes (mirrors `packages/db/test/kpi-views.test.ts`'s
 * own `Number(row.foo)` reads of the same view).
 */
export const WORK_ITEM_KPI_SELECT = `
  SELECT account_id, work_item_id, repo_id, kind, stage, created_at,
         t_discussing, t_spec_ready, t_in_progress, t_pr_opened,
         t_first_verdict, first_verdict_stage, t_needs_human, t_merged,
         t_closed_unmerged, t_closed, n_changes_requested, n_needs_human,
         model_usd, compute_usd, tokens
    FROM v_kpi_work_items
`;

export const RUN_KPI_SELECT = `
  SELECT account_id, run_id, work_item_id, repo_id, role, runtime, status,
         created_at, started_at, ended_at, tokens_in, tokens_out, model_usd, compute_usd
    FROM v_kpi_runs
`;

export const INSTALLATION_KPI_SELECT = `SELECT created_at, app_kind FROM installations`;

export function toWorkItemKpiRow(row: Record<string, unknown>): WorkItemKpiRow {
  return {
    account_id: row.account_id as string,
    work_item_id: row.work_item_id as string,
    repo_id: row.repo_id as string | null,
    kind: row.kind as string | null,
    stage: row.stage as string,
    created_at: row.created_at as Date,
    t_discussing: row.t_discussing as Date | null,
    t_spec_ready: row.t_spec_ready as Date | null,
    t_in_progress: row.t_in_progress as Date | null,
    t_pr_opened: row.t_pr_opened as Date | null,
    t_first_verdict: row.t_first_verdict as Date | null,
    first_verdict_stage: row.first_verdict_stage as 'changes_requested' | 'review_passed' | null,
    t_needs_human: row.t_needs_human as Date | null,
    t_merged: row.t_merged as Date | null,
    t_closed_unmerged: row.t_closed_unmerged as Date | null,
    t_closed: row.t_closed as Date | null,
    n_changes_requested: Number(row.n_changes_requested),
    n_needs_human: Number(row.n_needs_human),
    model_usd: Number(row.model_usd),
    compute_usd: Number(row.compute_usd),
    tokens: Number(row.tokens),
  };
}

function toRunKpiRow(row: Record<string, unknown>): RunKpiRow {
  return {
    account_id: row.account_id as string,
    run_id: row.run_id as string,
    work_item_id: row.work_item_id as string | null,
    repo_id: row.repo_id as string | null,
    role: row.role as string,
    runtime: row.runtime as 'local' | 'production',
    status: row.status as string,
    created_at: row.created_at as Date,
    started_at: row.started_at as Date | null,
    ended_at: row.ended_at as Date | null,
    tokens_in: row.tokens_in === null ? null : Number(row.tokens_in),
    tokens_out: row.tokens_out === null ? null : Number(row.tokens_out),
    model_usd: Number(row.model_usd),
    compute_usd: Number(row.compute_usd),
  };
}

export function toInstallationKpiRow(row: Record<string, unknown>): InstallationKpiRow {
  return {
    created_at: row.created_at as Date,
    app_kind: row.app_kind as InstallationAppKind,
  };
}

export interface GetStatsInput {
  from: Date;
  to: Date;
  /** `null` means "no repo filter"; the caller (the API route) already validated the uuid shape. */
  repoId: string | null;
  /** Injectable clock for tests (S3 criterion 2's fake-clock default-window test); defaults to `new Date()`. */
  now?: Date;
}

export interface GetStatsResult {
  window: { from: string; to: string; repo_id: string | null };
  generated_at: string;
  metrics: KpiResults;
}

/**
 * D#45 S3 criteria 2-4: the caller's KPIs for a `[from, to)` window,
 * optionally scoped to one `repo_id`. Runs inside `withTenant`, so RLS
 * alone confines every one of the three queries to the caller's own
 * account -- a `repo_id` from another tenant (or a random uuid) simply
 * matches none of the caller's own rows once filtered in JS below, giving
 * every count/rate/total its empty value rather than a 403 or 404 (S3
 * criterion 4: "identical bodies ... with every count 0").
 *
 * `first_pr_from_install` (criterion 4, last sentence) is account-level
 * and must not move when `repo_id` is given: it is always computed from
 * the FULL, unfiltered item set, never the repo-scoped one `computeKpis`
 * otherwise uses for the other 15 metrics.
 */
export async function getStats(ctx: StatsReadCtx, input: GetStatsInput): Promise<GetStatsResult> {
  const { accountId, userId } = ctx.principal;
  const { from, to, repoId, now } = input;
  const generatedAt = now ?? new Date();

  return withTenant(ctx.pool, accountId, userId, async (client) => {
    // Sequential, not `Promise.all` -- a single `PoolClient` (one
    // physical connection) can't run overlapping queries concurrently;
    // `pg` only warns (deprecated, not yet an error) rather than
    // rejecting, so this stays a plain `await` chain rather than a race.
    const itemsResult = await client.query(WORK_ITEM_KPI_SELECT);
    const runsResult = await client.query(RUN_KPI_SELECT);
    const installationsResult = await client.query(INSTALLATION_KPI_SELECT);
    const allItems = itemsResult.rows.map(toWorkItemKpiRow);
    const allRuns = runsResult.rows.map(toRunKpiRow);
    const installations = installationsResult.rows.map(toInstallationKpiRow);

    const scopedItems = repoId === null ? allItems : allItems.filter((item) => item.repo_id === repoId);
    const scopedRuns = repoId === null ? allRuns : allRuns.filter((run) => run.repo_id === repoId);

    const window = { from, to, now: generatedAt };
    const scoped = computeKpis({ items: scopedItems, runs: scopedRuns, installations }, window);
    const firstPrFromInstall =
      repoId === null
        ? scoped.first_pr_from_install
        : computeKpis({ items: allItems, runs: allRuns, installations }, window).first_pr_from_install;

    return {
      window: { from: from.toISOString(), to: to.toISOString(), repo_id: repoId },
      generated_at: generatedAt.toISOString(),
      metrics: { ...scoped, first_pr_from_install: firstPrFromInstall },
    };
  });
}

export interface TimelineTransition {
  from_stage: string;
  to_stage: string;
  reviewer: string | null;
  at: string;
  source: string;
  run_id: string | null;
}

export interface GetWorkItemTimelineResult {
  work_item_id: string;
  stage: string;
  transitions: TimelineTransition[];
  truncated: boolean;
}

/** S3 criterion 5: caps a returned page at 500 transitions; a 501st row (fetched only to detect it) flips `truncated`. */
const TIMELINE_PAGE_LIMIT = 500;

/**
 * D#45 S3 criterion 5. `source_ref`, `account_id` and `id` are never
 * selected (not merely stripped after the fact), so they can't leak
 * through a future column-order change. Malformed-id handling mirrors
 * `work-items/read.ts`'s `getWorkItem` exactly (CWE-639: a malformed id, a
 * random uuid and another tenant's real id must 404 identically).
 */
export async function getWorkItemTimeline(ctx: StatsReadCtx, workItemId: string): Promise<GetWorkItemTimelineResult> {
  if (!UUID_RE.test(workItemId)) {
    throw new NotFoundError(`work item ${workItemId} not found`);
  }
  const { accountId, userId } = ctx.principal;
  return withTenant(ctx.pool, accountId, userId, async (client) => {
    const { rows: itemRows } = await client.query<{ stage: string }>(
      `SELECT stage FROM work_items WHERE id = $1::uuid`,
      [workItemId],
    );
    const item = itemRows[0];
    if (!item) {
      throw new NotFoundError(`work item ${workItemId} not found`);
    }

    const { rows } = await client.query<{
      from_stage: string;
      to_stage: string;
      reviewer: string | null;
      at: Date;
      source: string;
      run_id: string | null;
    }>(
      `SELECT from_stage, to_stage, reviewer, at, source, run_id
         FROM work_item_transitions
        WHERE work_item_id = $1::uuid
        ORDER BY at ASC, created_at ASC, id ASC
        LIMIT $2::int`,
      [workItemId, TIMELINE_PAGE_LIMIT + 1],
    );
    const truncated = rows.length > TIMELINE_PAGE_LIMIT;
    const page = truncated ? rows.slice(0, TIMELINE_PAGE_LIMIT) : rows;

    return {
      work_item_id: workItemId,
      stage: item.stage,
      transitions: page.map((row) => ({
        from_stage: row.from_stage,
        to_stage: row.to_stage,
        reviewer: row.reviewer,
        at: row.at.toISOString(),
        source: row.source,
        run_id: row.run_id,
      })),
      truncated,
    };
  });
}
