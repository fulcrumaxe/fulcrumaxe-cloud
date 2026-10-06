import type { Pool } from 'pg';
import { computePlan, type ComputedPlan, type PullFacts } from './computePlan.js';
import { decideOwnerProcess } from './ownerProcess.js';
import {
  ImportNotRunningError,
  writeFailedImport,
  writeSucceededImport,
  type ImportErrorCode,
  type ImportEvidence,
  type ImportPrincipal,
} from './persist.js';
import { MAX_PLAN_TASKS, PlanFileInconsistentError, PlanFileShapeError, parseRoadmapFile } from './roadmapFile.js';

/**
 * D#483 S3 level 1: run one import that `beginPlanImport` has started. It reads everything first (through the PlanSource,
 * which can only read), decides, and then writes in one transaction. It never writes to GitHub (the source has no way to) and
 * starts nothing (the write transaction runs as the import's own database role, which has no grant on work items or runs).
 *
 * Level 1 only: a roadmap file read from the default branch. When there is none, or it is the wrong shape, the import ends
 * as failed with `plan_file_missing` or `plan_file_shape` and says why; the Spec's fall-through to Spec task tables and to
 * issues and Discussions is the permanent build's (S3-c2 and later).
 */
export const ROADMAP_PATHS: readonly string[] = ['.fulcrumaxe/roadmap.json', '.autonomous-team/roadmap.json', 'roadmap.json'];
/** The marker that the engine loop (the repo's own development loop) is installed. */
export const ENGINE_LOOP_MARKER = '.autonomous-team/project.json';
export const MAX_ROADMAP_BYTES = 5 * 1024 * 1024;
const ENGINE_MARKER_MAX_BYTES = 1024 * 1024;

export interface PlanSource {
  /** The default branch and its head commit. */
  head(): Promise<{ defaultBranch: string; sha: string }>;
  /** A file at a commit, or null when it is not there. Over `maxBytes` throws an error whose `code` is `plan_file_too_large`. */
  file(path: string, ref: string, maxBytes: number): Promise<string | null>;
  /** Every pull request of the repository, with the facts the counting rule needs. `truncated` when a bound stopped the read. */
  pulls(): Promise<{ pulls: PullFacts[]; truncated: boolean }>;
  /** What was asked of GitHub and what the minted token could do (acceptance A2). Read after the reads. */
  evidence(): ImportEvidence;
}

export interface ExecuteInput {
  pool: Pool;
  principal: ImportPrincipal;
  repoId: string;
  importId: string;
  source: PlanSource;
}

export type ImportOutcome =
  | { state: 'succeeded'; importId: string; computed: ComputedPlan; truncated: boolean; sourcePath: string; sourceSha: string; maxMergedPr: number; evidence: ImportEvidence }
  | { state: 'failed'; importId: string; code: ImportErrorCode; detail: string | null };

const FAILURE_CODES: ReadonlySet<string> = new Set([
  'repo_not_connected',
  'app_permission_missing',
  'discussions_disabled',
  'plan_file_too_large',
  'token_not_read_only',
  'github_unavailable',
  'rate_limited_by_github',
]);

/** A failure the source (the GitHub client) raised, in the import's own codes. Anything else is `internal_error`. */
function codeOf(err: unknown): ImportErrorCode {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && FAILURE_CODES.has(code) ? (code as ImportErrorCode) : 'internal_error';
}

export async function executePlanImport(input: ExecuteInput): Promise<ImportOutcome> {
  const { pool, principal, repoId, importId, source } = input;
  const fail = async (code: ImportErrorCode, detail: string | null): Promise<ImportOutcome> => {
    let evidence: ImportEvidence | null = null;
    try {
      evidence = source.evidence();
    } catch {
      // fx-swallow-ok: the evidence is a bonus on a failed import; the failure itself is what is recorded
      evidence = null;
    }
    await writeFailedImport(pool, principal, importId, code, detail, evidence);
    return { state: 'failed', importId, code, detail };
  };

  try {
    const head = await source.head();
    let sourcePath: string | null = null;
    let text: string | null = null;
    for (const path of ROADMAP_PATHS) {
      text = await source.file(path, head.sha, MAX_ROADMAP_BYTES);
      if (text !== null) {
        sourcePath = path;
        break;
      }
    }
    if (text === null || sourcePath === null) return await fail('plan_file_missing', `none of ${ROADMAP_PATHS.join(', ')} exists on the default branch`);

    let plan;
    try {
      plan = parseRoadmapFile(text);
    } catch (err) {
      if (err instanceof PlanFileShapeError) return await fail('plan_file_shape', err.message);
      if (err instanceof PlanFileInconsistentError) return await fail('plan_file_inconsistent', err.message);
      throw err;
    }
    let truncated = false;
    if (plan.tasks.length > MAX_PLAN_TASKS) {
      // A bound is counted, never guessed: the first MAX_PLAN_TASKS tasks are kept and the import says it is partial.
      const keep = new Set(plan.tasks.slice(0, MAX_PLAN_TASKS).map((t) => t.key));
      plan = { milestones: plan.milestones.map((m) => ({ ...m, taskKeys: m.taskKeys.filter((k) => keep.has(k)) })), tasks: plan.tasks.slice(0, MAX_PLAN_TASKS) };
      truncated = true;
    }

    const loop = await source.file(ENGINE_LOOP_MARKER, head.sha, ENGINE_MARKER_MAX_BYTES);
    const owner = decideOwnerProcess({ repoHasEngineLoop: loop !== null, kind: 'task' });

    const read = await source.pulls();
    if (read.truncated) truncated = true;
    const computed = computePlan(plan, read.pulls);
    const maxMergedPr = read.pulls.reduce((max, p) => (p.state === 'merged' && p.number > max ? p.number : max), 0);
    const evidence = source.evidence();

    await writeSucceededImport(pool, principal, {
      importId,
      repoId,
      sourcePath,
      sourceSha: head.sha,
      plan,
      computed,
      owner,
      truncated,
      maxMergedPr,
      evidence,
    });
    return { state: 'succeeded', importId, computed, truncated, sourcePath, sourceSha: head.sha, maxMergedPr, evidence };
  } catch (err) {
    // The row was closed by someone else (the interrupted rule): there is nothing of ours left to write.
    if (err instanceof ImportNotRunningError) throw err;
    const code = codeOf(err);
    if (code !== 'internal_error') return fail(code, null);
    // An unexpected failure: keep the error's name and message (never its stack, request or token) so the row says why.
    const name = err instanceof Error ? err.name : typeof err;
    const message = err instanceof Error ? err.message : String(err);
    const detail = `${name}: ${message}`.slice(0, 500);
    console.warn(`plan import ${importId}: internal_error ${detail}`);
    return fail(code, detail);
  }
}
