import type { Pool } from 'pg';
import { NotFoundError } from '../tenancy/errors.js';
import { withTenant } from '../tenancy/withTenant.js';

/**
 * D#483 S3: the reads behind the plan routes. All of it goes through `withTenant` (the app_user role, row level security);
 * nothing here writes. Milestone counts are DERIVED from the task rows on every read, never copied: the counts stored on an
 * import (`plan_imports.counts`) are that import's historical stamp, shown with its time.
 */
export interface PlanReadCtx {
  pool: Pool;
  principal: { accountId: string; userId: string };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PlanImportRow {
  id: string;
  repo_id: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed';
  level: string | null;
  source_path: string | null;
  source_sha: string | null;
  counts: Record<string, unknown>;
  truncated: boolean;
  error_code: string | null;
  error_detail: string | null;
  max_merged_pr: number | null;
  github_requests: unknown;
  token_permissions: unknown;
  started_at: string | null;
  finished_at: string | null;
}

const IMPORT_COLUMNS = `id, repo_id, state, level, source_path, source_sha, counts, truncated, error_code, error_detail, max_merged_pr,
  github_requests, token_permissions, started_at, finished_at`;

function assertRepoId(repoId: string): void {
  if (!UUID_RE.test(repoId)) throw new NotFoundError(`repos ${repoId} not found`);
}

function toIso(row: Record<string, unknown>): PlanImportRow {
  const r = row as unknown as PlanImportRow & { started_at: Date | null; finished_at: Date | null };
  return { ...r, started_at: r.started_at ? new Date(r.started_at).toISOString() : null, finished_at: r.finished_at ? new Date(r.finished_at).toISOString() : null };
}

/** The repo's newest import of any state, or null when it was never imported. An unknown repo is NotFoundError. */
export async function getLatestPlanImport(ctx: PlanReadCtx, repoId: string): Promise<PlanImportRow | null> {
  assertRepoId(repoId);
  return withTenant(ctx.pool, ctx.principal.accountId, ctx.principal.userId, async (client) => {
    const repo = await client.query('SELECT 1 FROM repos WHERE id = $1::uuid', [repoId]);
    if (repo.rowCount === 0) throw new NotFoundError(`repos ${repoId} not found`);
    const { rows } = await client.query(`SELECT ${IMPORT_COLUMNS} FROM plan_imports WHERE repo_id = $1::uuid ORDER BY created_at DESC, id DESC LIMIT 1`, [repoId]);
    return rows[0] ? toIso(rows[0]) : null;
  });
}

export interface PlanMilestoneView {
  key: string;
  title: string;
  position: number;
  tasks: number;
  done: number;
  remaining: number;
}

export interface PlanTaskView {
  task_key: string;
  milestone_key: string;
  title: string;
  status: string;
  planned_prs: number;
  merged_prs: number[];
  open_prs: number[];
  owner_process: string;
}

export interface PlanViewQuery {
  milestone?: string;
  status?: 'done' | 'remaining';
  cursor?: string;
  limit?: number;
  full?: boolean;
}

export interface PlanView {
  latest_import: PlanImportRow | null;
  /** The newest import that succeeded: the one the rows below came from. */
  imported_from: PlanImportRow | null;
  milestones: PlanMilestoneView[];
  totals: { tasks: number; done: number; remaining: number };
  tasks: PlanTaskView[];
  next_cursor: string | null;
  /** True only for a full read that hit PLAN_FULL_MAX and left tasks out. */
  tasks_truncated: boolean;
}

export const PLAN_PAGE_SIZE = 100;
export const PLAN_FULL_MAX = 5000;

export async function getPlanView(ctx: PlanReadCtx, repoId: string, q: PlanViewQuery = {}): Promise<PlanView> {
  assertRepoId(repoId);
  return withTenant(ctx.pool, ctx.principal.accountId, ctx.principal.userId, async (client) => {
    const repo = await client.query('SELECT 1 FROM repos WHERE id = $1::uuid', [repoId]);
    if (repo.rowCount === 0) throw new NotFoundError(`repos ${repoId} not found`);
    const latest = (await client.query(`SELECT ${IMPORT_COLUMNS} FROM plan_imports WHERE repo_id = $1::uuid ORDER BY created_at DESC, id DESC LIMIT 1`, [repoId])).rows[0];
    const from = (await client.query(`SELECT ${IMPORT_COLUMNS} FROM plan_imports WHERE repo_id = $1::uuid AND state = 'succeeded' ORDER BY created_at DESC, id DESC LIMIT 1`, [repoId])).rows[0];

    const ms = await client.query<PlanMilestoneView>(
      `SELECT m.key, m.title, m.position,
              count(t.id)::int AS tasks,
              (count(t.id) FILTER (WHERE t.status = 'done'))::int AS done,
              (count(t.id) FILTER (WHERE t.status <> 'done'))::int AS remaining
         FROM plan_milestones m
         LEFT JOIN plan_tasks t ON t.repo_id = m.repo_id AND t.milestone_key = m.key AND t.removed_at IS NULL
        WHERE m.repo_id = $1::uuid AND m.removed_at IS NULL
        GROUP BY m.key, m.title, m.position
        ORDER BY m.position, m.key`,
      [repoId],
    );
    const totals = ms.rows.reduce((a, m) => ({ tasks: a.tasks + m.tasks, done: a.done + m.done, remaining: a.remaining + m.remaining }), { tasks: 0, done: 0, remaining: 0 });

    const limit = q.full ? PLAN_FULL_MAX : Math.min(Math.max(q.limit ?? PLAN_PAGE_SIZE, 1), PLAN_PAGE_SIZE);
    const params: unknown[] = [repoId];
    const where = ['t.repo_id = $1::uuid', 't.removed_at IS NULL'];
    if (q.milestone !== undefined) {
      params.push(q.milestone);
      where.push(`t.milestone_key = $${params.length}`);
    }
    if (q.status === 'done') where.push(`t.status = 'done'`);
    if (q.status === 'remaining') where.push(`t.status <> 'done'`);
    if (q.cursor !== undefined && !q.full) {
      params.push(q.cursor);
      where.push(`t.task_key > $${params.length}`);
    }
    params.push(limit + 1);
    const tasks = await client.query<PlanTaskView>(
      `SELECT t.task_key, t.milestone_key, t.title, t.status, t.planned_prs, t.merged_prs, t.open_prs, t.owner_process
         FROM plan_tasks t JOIN plan_milestones m ON m.repo_id = t.repo_id AND m.key = t.milestone_key
        WHERE ${where.join(' AND ')}
        ORDER BY t.task_key
        LIMIT $${params.length}::int`,
      params,
    );
    const hasMore = tasks.rows.length > limit;
    const page = hasMore ? tasks.rows.slice(0, limit) : tasks.rows;
    return {
      latest_import: latest ? toIso(latest) : null,
      imported_from: from ? toIso(from) : null,
      milestones: ms.rows,
      totals,
      tasks: page,
      next_cursor: hasMore && !q.full ? page[page.length - 1]!.task_key : null,
      // `?format=full` stops at PLAN_FULL_MAX rows; say so rather than looking complete.
      tasks_truncated: Boolean(q.full) && hasMore,
    };
  });
}
