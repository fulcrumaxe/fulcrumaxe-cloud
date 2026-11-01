import type { Pool } from 'pg';
import { withTenant } from './withTenant.js';

/**
 * D#483 S4-f2: the docs-and-code analysis queue, over migrations/0950_discovery_analyses.sql.
 *
 * One analysis per repository and default-branch head: the row's key is (repo, head sha), so a head that was already queued, ended or
 * skipped can never queue again. `ON CONFLICT DO NOTHING` is the whole idempotency rule; no caller checks first. Queuing writes only
 * the queue (nothing starts a run). The moves below are the legal ones the table's guard allows; the guard, not these helpers, refuses
 * the rest.
 */
export const ANALYSIS_TRIGGERS = ['sweep'] as const;
export type AnalysisTrigger = (typeof ANALYSIS_TRIGGERS)[number];
export type AnalysisEnd = 'succeeded' | 'skipped' | 'failed';

export interface QueuedAnalysis {
  id: string;
  repoId: string;
  headSha: string;
}

const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** Queues the analysis of `headSha` for one repository. Answers the new row, or null when that head was already queued (a replay). */
export async function queueAnalysis(pool: Pool, accountId: string, repoId: string, headSha: string, trigger: AnalysisTrigger = 'sweep'): Promise<QueuedAnalysis | null> {
  if (!ANALYSIS_TRIGGERS.includes(trigger)) throw new Error('analysis: unknown trigger');
  if (!SHA_RE.test(headSha)) throw new Error('analysis: head is not a full commit sha');
  return withTenant(pool, accountId, async (client) => {
    const { rows } = await client.query<{ id: string; repo_id: string; head_sha: string }>(
      `INSERT INTO discovery_analyses (account_id, repo_id, head_sha, trigger) VALUES ($1, $2, $3, $4)
       ON CONFLICT (repo_id, head_sha) DO NOTHING RETURNING id, repo_id, head_sha`,
      [accountId, repoId, headSha, trigger],
    );
    const r = rows[0];
    return r ? { id: r.id, repoId: r.repo_id, headSha: r.head_sha } : null;
  });
}

/** queued to running, once (the claim). Answers false when the row is not queued. */
export async function startAnalysis(pool: Pool, accountId: string, id: string, runId: string | null = null): Promise<boolean> {
  return withTenant(pool, accountId, async (client) => {
    const res = await client.query(
      `UPDATE discovery_analyses SET state = 'running', started_at = now(), run_id = $3, attempts = attempts + 1 WHERE id = $1 AND account_id = $2 AND state = 'queued'`,
      [id, accountId, runId],
    );
    return res.rowCount === 1;
  });
}

/** Ends a queued or running analysis. `code` is the closed skip reason or failure code (required for skipped and failed). Answers false when it already ended. */
export async function endAnalysis(pool: Pool, accountId: string, id: string, state: AnalysisEnd, code: string | null, counts: Record<string, number> | null = null): Promise<boolean> {
  if (code !== null && !CODE_RE.test(code)) throw new Error('analysis: the code is a closed lowercase word');
  return withTenant(pool, accountId, async (client) => {
    const res = await client.query(
      `UPDATE discovery_analyses SET state = $3, skip_reason = $4, counts = $5::jsonb, finished_at = now()
        WHERE id = $1 AND account_id = $2 AND state IN ('queued', 'running')`,
      [id, accountId, state, code, counts === null ? null : JSON.stringify(counts)],
    );
    return res.rowCount === 1;
  });
}
