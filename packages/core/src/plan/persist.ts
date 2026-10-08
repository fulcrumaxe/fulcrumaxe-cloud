import type { Pool, PoolClient } from 'pg';
import { withTenant } from '../tenancy/withTenant.js';
import { ForbiddenError, NotFoundError } from '../tenancy/errors.js';
import type { ComputedPlan, ComputedTask } from './computePlan.js';
import type { ItemProposal } from './issuesLevel.js';
import type { OwnerProcess } from './ownerProcess.js';
import type { ParsedPlan } from './roadmapFile.js';

/**
 * D#483 S3: the plan import's database side.
 *
 *   beginPlanImport     the start (0723's plan_import_begin definer): owner or admin session, repo connected, one active
 *                       import per repo, the hourly limits. Its own short transaction, committed, so the running row is
 *                       visible to a second request at once.
 *   writeSucceededImport  the one write transaction. It runs `SET LOCAL ROLE plan_importer`, the import's own role: no grant
 *                       on work_items, agent_runs or run_action_requests (M0 rule E4), and a guard that lets it move a
 *                       proposal only between new and withdrawn (it can never decide one). Everything is read first and
 *                       written here at once, so a failure leaves the previous import's rows as they were.
 *   writeFailedImport   closes the running row as failed, with the code and (for some codes) the first problem in words.
 *
 * A task or milestone missing from a later import gets `removed_at`, never a delete. A proposal for a task that is now
 * done or gone and is still `new` becomes `withdrawn`; a withdrawn one whose task is remaining again becomes `new`; an
 * approved or rejected one is never touched by an import (a person's decision).
 */
export class ImportRunningError extends Error {
  constructor() {
    super('an import is already running for this repository');
    this.name = 'ImportRunningError';
  }
}
export class ImportRepoNotConnectedError extends Error {
  constructor() {
    super("this repository isn't connected any more");
    this.name = 'ImportRepoNotConnectedError';
  }
}
export class ImportRateLimitedError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('too many imports in the last hour');
    this.name = 'ImportRateLimitedError';
  }
}
/** The import's request ended before the write (it was closed as interrupted, or already finished). */
export class ImportNotRunningError extends Error {
  constructor() {
    super('the import is no longer running');
    this.name = 'ImportNotRunningError';
  }
}

export interface ImportPrincipal {
  accountId: string;
  userId: string;
}

export type ImportErrorCode =
  | 'repo_not_connected'
  | 'app_permission_missing'
  | 'discussions_disabled'
  | 'plan_file_inconsistent'
  | 'plan_file_too_large'
  | 'token_not_read_only'
  | 'github_unavailable'
  | 'rate_limited_by_github'
  | 'request_budget_exhausted'
  | 'plan_source_too_large'
  | 'plan_file_missing'
  | 'plan_file_shape'
  | 'interrupted'
  | 'internal_error';

/** The Plan view's sentence for `request_budget_exhausted` (the thirteenth error sentence). S3-L2b renders it. */
export const REQUEST_BUDGET_EXHAUSTED_SENTENCE =
  'Reading your repo took more requests than one import is allowed, so nothing was changed. Your previous plan is still shown.';

/**
 * The Plan view's sentence for `plan_source_too_large` (the fourteenth error sentence). S3-L2b renders it. Hiding spam
 * comments on GitHub is the undo path: a minimized comment is skipped and not counted at the next import.
 */
export const PLAN_SOURCE_TOO_LARGE_SENTENCE =
  'Your repo has more planning Discussions or Correction comments than one import can read, so nothing was changed. Your previous plan is still shown. Hiding spam comments on GitHub brings the count back down.';

export interface ImportEvidence {
  requests: Array<{ method: string; path: string; status: number }>;
  tokenPermissions: Record<string, string> | null;
}

interface PgLike {
  code?: string;
  message?: string;
  hint?: string;
}

export async function beginPlanImport(pool: Pool, principal: ImportPrincipal, repoId: string): Promise<string> {
  try {
    return await withTenant(pool, principal.accountId, principal.userId, async (client) => {
      const { rows } = await client.query<{ id: string }>('SELECT plan_import_begin($1::uuid) AS id', [repoId]);
      return rows[0]!.id;
    });
  } catch (err) {
    const e = err as PgLike;
    if (e.code === '55000' && e.message === 'import_running') throw new ImportRunningError();
    if (e.code === '55000' && e.message === 'repo_not_connected') throw new ImportRepoNotConnectedError();
    if (e.code === '53400' && e.message === 'rate_limited') throw new ImportRateLimitedError(Math.max(1, Number(e.hint) || 60));
    if (e.code === '42501') throw new ForbiddenError('not permitted');
    if (e.code === 'P0002') throw new NotFoundError('repo not found');
    throw err;
  }
}

export type ImportLevel = 'roadmap_file' | 'spec_tables' | 'issues_discussions';

export interface SucceededImport {
  importId: string;
  repoId: string;
  /** Which level the import used (the fallback order is roadmap_file, spec_tables, issues_discussions). */
  level: ImportLevel;
  /** The roadmap file's path at level 1; null at the other levels. */
  sourcePath: string | null;
  /** Why an earlier level was passed over (the roadmap file's shape problem), shown with the level. */
  fallbackNote?: string | null;
  sourceSha: string;
  /** Level 3 only: one proposal per open issue and Discussion. */
  itemProposals?: ItemProposal[];
  plan: ParsedPlan;
  computed: ComputedPlan;
  owner: OwnerProcess;
  truncated: boolean;
  maxMergedPr: number;
  evidence: ImportEvidence;
}

/** What `plan_imports.counts` holds: this import's stamp. */
export function countsOf(computed: ComputedPlan, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...computed.totals, per_milestone: computed.perMilestone, ...extra };
}

const MILESTONES_SQL = `
  INSERT INTO plan_milestones (account_id, repo_id, key, title, position, last_import_id)
  SELECT $1::uuid, $2::uuid, m.key, m.title, m.position, $3::uuid
    FROM jsonb_to_recordset($4::jsonb) AS m(key text, title text, position int)
  ON CONFLICT (repo_id, key) DO UPDATE
    SET title = EXCLUDED.title, position = EXCLUDED.position, last_import_id = EXCLUDED.last_import_id, removed_at = NULL`;

const TASKS_SQL = `
  INSERT INTO plan_tasks (account_id, repo_id, task_key, milestone_key, discussion_number, title, planned_prs, merged_prs,
                          open_prs, status, is_leaf, parent_key, owner_process, evidence, evidence_dropped, first_import_id, last_import_id)
  SELECT $1::uuid, $2::uuid, t.task_key, t.milestone_key, t.discussion_number, t.title, t.planned_prs,
         ARRAY(SELECT jsonb_array_elements_text(t.merged_prs))::int[], ARRAY(SELECT jsonb_array_elements_text(t.open_prs))::int[],
         t.status, true, t.parent_key, $5::text, t.evidence, t.evidence_dropped, $3::uuid, $3::uuid
    FROM jsonb_to_recordset($4::jsonb) AS t(task_key text, milestone_key text, discussion_number int, title text, planned_prs int,
                                             merged_prs jsonb, open_prs jsonb, status text, parent_key text, evidence jsonb, evidence_dropped jsonb)
  ON CONFLICT (repo_id, task_key) DO UPDATE
    SET milestone_key = EXCLUDED.milestone_key, discussion_number = EXCLUDED.discussion_number, title = EXCLUDED.title,
        planned_prs = EXCLUDED.planned_prs, merged_prs = EXCLUDED.merged_prs, open_prs = EXCLUDED.open_prs, status = EXCLUDED.status,
        is_leaf = true, parent_key = EXCLUDED.parent_key, owner_process = EXCLUDED.owner_process, evidence = EXCLUDED.evidence,
        evidence_dropped = EXCLUDED.evidence_dropped, last_import_id = EXCLUDED.last_import_id, removed_at = NULL, updated_at = now()`;

/** A remaining leaf task becomes a proposal. A withdrawn one comes back to new; an approved or rejected one keeps its state. The owner is fixed when the row is created (0753 refuses the import role any change to it). */
const PROPOSALS_SQL = `
  INSERT INTO proposals (account_id, repo_id, dedupe_key, sources, plan_task_id, discussion_number, title, summary, provenance, owner_process, state, last_import_id)
  SELECT $1::uuid, $2::uuid, 'plan:' || t.task_key, ARRAY['plan_task'], pt.id, t.discussion_number, left(t.title, 256), left(t.summary, 2000),
         'internal', $5::text, 'new', $3::uuid
    FROM jsonb_to_recordset($4::jsonb) AS t(task_key text, discussion_number int, title text, summary text)
    JOIN plan_tasks pt ON pt.repo_id = $2::uuid AND pt.task_key = t.task_key
  ON CONFLICT (repo_id, dedupe_key) DO UPDATE
    SET plan_task_id = EXCLUDED.plan_task_id, discussion_number = EXCLUDED.discussion_number, title = EXCLUDED.title, summary = EXCLUDED.summary,
        owner_process = proposals.owner_process,
        state = CASE WHEN proposals.state = 'withdrawn' THEN 'new' ELSE proposals.state END,
        last_import_id = EXCLUDED.last_import_id, updated_at = now()`;

/** An open issue or Discussion becomes a proposal; a withdrawn one comes back to new; an approved or rejected one keeps its state. The owner is fixed when the row is created and never rewritten by an import. */
const ITEM_PROPOSALS_SQL = `
  INSERT INTO proposals (account_id, repo_id, dedupe_key, sources, gh_number, discussion_number, title, summary, provenance, owner_process, state, last_import_id)
  SELECT $1::uuid, $2::uuid, p.dedupe_key, ARRAY[p.source], p.gh_number, p.discussion_number, left(p.title, 256), left(p.summary, 2000),
         'external', p.owner, 'new', $3::uuid
    FROM jsonb_to_recordset($4::jsonb) AS p(dedupe_key text, source text, gh_number int, discussion_number int, title text, summary text, owner text)
  ON CONFLICT (repo_id, dedupe_key) DO UPDATE
    SET title = EXCLUDED.title, summary = EXCLUDED.summary,
        state = CASE WHEN proposals.state = 'withdrawn' THEN 'new' ELSE proposals.state END,
        last_import_id = EXCLUDED.last_import_id, updated_at = now()`;

function taskPayload(t: ComputedTask): Record<string, unknown> {
  return {
    task_key: t.key,
    milestone_key: t.milestoneKey,
    discussion_number: t.discussionNumber !== null && t.discussionNumber <= 2147483647 ? t.discussionNumber : null,
    title: t.title,
    summary: t.summary,
    planned_prs: t.plannedPrs,
    merged_prs: t.mergedPrs,
    open_prs: t.openPrs,
    status: t.status,
    parent_key: t.parentKey,
    evidence: t.evidence,
    evidence_dropped: t.evidenceDropped,
  };
}

async function lockRunning(client: PoolClient, importId: string): Promise<void> {
  const { rows } = await client.query<{ state: string }>('SELECT state FROM plan_imports WHERE id = $1::uuid FOR UPDATE', [importId]);
  if (rows[0]?.state !== 'running') throw new ImportNotRunningError();
}

export async function writeSucceededImport(pool: Pool, principal: ImportPrincipal, w: SucceededImport): Promise<void> {
  await withTenant(pool, principal.accountId, principal.userId, async (client) => {
    await client.query('SET LOCAL ROLE plan_importer');
    await lockRunning(client, w.importId);
    const { accountId } = principal;
    await client.query(MILESTONES_SQL, [accountId, w.repoId, w.importId, JSON.stringify(w.plan.milestones.map((m) => ({ key: m.key, title: m.title, position: m.position })))]);
    const tasks = w.computed.tasks.map(taskPayload);
    await client.query(TASKS_SQL, [accountId, w.repoId, w.importId, JSON.stringify(tasks), w.owner]);
    // Rows this import did not touch are gone from the file: marked, not deleted.
    await client.query(`UPDATE plan_tasks SET removed_at = now(), updated_at = now() WHERE repo_id = $1::uuid AND last_import_id IS DISTINCT FROM $2::uuid AND removed_at IS NULL`, [w.repoId, w.importId]);
    await client.query(`UPDATE plan_milestones SET removed_at = now() WHERE repo_id = $1::uuid AND last_import_id IS DISTINCT FROM $2::uuid AND removed_at IS NULL`, [w.repoId, w.importId]);
    // Proposals: remaining leaf tasks only. Done tasks never become proposals.
    const remaining = w.computed.tasks.filter((t) => t.status !== 'done').map(taskPayload);
    await client.query(PROPOSALS_SQL, [accountId, w.repoId, w.importId, JSON.stringify(remaining), w.owner]);
    if (w.itemProposals && w.itemProposals.length > 0) {
      const items = w.itemProposals.map((p) => ({ dedupe_key: p.dedupeKey, source: p.source, gh_number: p.ghNumber, discussion_number: p.discussionNumber, title: p.title, summary: p.summary, owner: p.owner }));
      await client.query(ITEM_PROPOSALS_SQL, [accountId, w.repoId, w.importId, JSON.stringify(items)]);
    }
    // A `new` proposal this import did not touch belongs to a task, issue or Discussion that is now done, closed or gone (or to a
    // level the repo no longer uses): derived, so withdrawn. A proposal from another source (a preview) is not the importer's.
    await client.query(
      `UPDATE proposals SET state = 'withdrawn', last_import_id = $2::uuid, updated_at = now()
        WHERE repo_id = $1::uuid AND state = 'new' AND sources && ARRAY['plan_task', 'github_issue', 'github_discussion']::text[]
          AND last_import_id IS DISTINCT FROM $2::uuid`,
      [w.repoId, w.importId],
    );
    await client.query(
      `UPDATE plan_imports
          SET state = 'succeeded', level = $9, source_path = $2, source_sha = $3, counts = $4::jsonb, truncated = $5,
              max_merged_pr = $6, github_requests = $7::jsonb, token_permissions = $8::jsonb, error_detail = $10, finished_at = now()
        WHERE id = $1::uuid`,
      [
        w.importId,
        w.sourcePath,
        w.sourceSha,
        JSON.stringify(countsOf(w.computed)),
        w.truncated,
        w.maxMergedPr,
        JSON.stringify(w.evidence.requests),
        JSON.stringify(w.evidence.tokenPermissions ?? {}),
        w.level,
        w.fallbackNote ? w.fallbackNote.slice(0, 500) : null,
      ],
    );
  });
}

export async function writeFailedImport(
  pool: Pool,
  principal: ImportPrincipal,
  importId: string,
  code: ImportErrorCode,
  detail: string | null,
  evidence: ImportEvidence | null,
): Promise<void> {
  await withTenant(pool, principal.accountId, principal.userId, async (client) => {
    await client.query('SET LOCAL ROLE plan_importer');
    await client.query(
      `UPDATE plan_imports
          SET state = 'failed', error_code = $2, error_detail = $3, github_requests = $4::jsonb, token_permissions = $5::jsonb, finished_at = now()
        WHERE id = $1::uuid AND state = 'running'`,
      [importId, code, detail === null ? null : detail.slice(0, 500), evidence ? JSON.stringify(evidence.requests) : null, evidence?.tokenPermissions ? JSON.stringify(evidence.tokenPermissions) : null],
    );
  });
}
