import type { Pool } from 'pg';
import type { RepoPermission } from '@fx/trust';
import { computePlan, type ComputedPlan, type PullFacts } from './computePlan.js';
import { buildIssuesLevel, type DiscussionFacts, type IssueFacts, type ItemProposal } from './issuesLevel.js';
import { decideOwnerProcess, type OwnerProcess } from './ownerProcess.js';
import { isCorrectionComment, isSpecDiscussion, memoizePermissions, parseSpecTables, trustedCorrectionAuthors, trustedSpecDiscussions, type SpecComment } from './specTables.js';
import {
  ImportNotRunningError,
  type ImportLevel,
  writeFailedImport,
  writeSucceededImport,
  type ImportErrorCode,
  type ImportEvidence,
  type ImportPrincipal,
} from './persist.js';
import { MAX_PLAN_TASKS, PlanFileInconsistentError, PlanFileShapeError, parseRoadmapFile, type ParsedPlan } from './roadmapFile.js';

/**
 * D#483 S3 level 1: run one import that `beginPlanImport` has started. It reads everything first (through the PlanSource,
 * which can only read), decides, and then writes in one transaction. It never writes to GitHub (the source has no way to) and
 * starts nothing (the write transaction runs as the import's own database role, which has no grant on work items or runs).
 *
 * It picks the first level the repo supports and records which one it used:
 *   1. a roadmap file on the default branch (`roadmap_file`);
 *   2. Spec task tables in the repo's Discussions (only Discussions written by an admin or maintainer count as Specs), with
 *      their trusted Corrections (`spec_tables`);
 *   3. open issues and Discussions, one proposal each (`issues_discussions`).
 * A missing roadmap file falls through. So does a file of the wrong shape, and the import keeps the shape problem ("roadmap.json
 * didn't match the expected shape: ...") as the note shown with the level it ended at. A file that contradicts itself
 * (`plan_file_inconsistent`) does NOT fall through: it fails, naming the key, and the earlier import's data stays.
 *
 * Running out of the request budget is a failure, not a partial import, wherever the missing read decides what the plan is:
 * the Discussion reads, the author trust lookups and the pull request read all end the import `failed` with
 * `request_budget_exhausted`, and the write transaction never starts, so the earlier import's data stays. Only the level 3
 * issues listing, which has no trust or merged-pull-request input, still ends as a partial (`truncated`) import.
 *
 * Level 2 reads every page of the Discussions and of each Spec's comments, and only items that can change the plan count
 * toward a bound: Spec-shaped Discussions (at most 600) and, per Spec, Correction-shaped comments that are not minimized (at
 * most 300). Passing either bound ends the import `failed` with `plan_source_too_large`, the same way, because dropping some of
 * them would leave a plan that is silently wrong. The level 3 Discussion list keeps its own bound and its partial result.
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
  /**
   * Reads every page of the Discussions. `discussions` is the level 3 list (oldest first, bounded, `truncated` when cut) and
   * `specs` is every Discussion `match.isSpec` accepts (level 2, never cut). More Spec-shaped Discussions than the bound throws
   * an error whose `code` is `plan_source_too_large`. `discussions_disabled` and `app_permission_missing` are thrown as codes.
   */
  discussions(match: { isSpec(body: string): boolean }): Promise<{
    discussions: Array<DiscussionFacts & { authorLogin: string | null }>;
    specs: Array<DiscussionFacts & { authorLogin: string | null }>;
    truncated: boolean;
  }>;
  /**
   * Level 2: one Discussion's comments, every page, keeping only those `match.isCorrection` accepts that are not minimized.
   * More kept comments than the bound throws an error whose `code` is `plan_source_too_large`.
   */
  discussionComments(number: number, match: { isCorrection(body: string): boolean }): Promise<{ comments: SpecComment[] }>;
  /** Level 3: the repository's issues (pull requests already split off). Shares one read with `pulls()`. */
  issues(): Promise<{ issues: IssueFacts[]; truncated: boolean }>;
  /** A login's real permission on the repository (a person who is not a collaborator is `none`). */
  authorPermission(login: string): Promise<RepoPermission>;
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
  | { state: 'succeeded'; importId: string; level: ImportLevel; computed: ComputedPlan; truncated: boolean; sourcePath: string | null; sourceSha: string; maxMergedPr: number; evidence: ImportEvidence }
  | { state: 'failed'; importId: string; code: ImportErrorCode; detail: string | null };

const FAILURE_CODES: ReadonlySet<string> = new Set([
  'repo_not_connected',
  'app_permission_missing',
  'discussions_disabled',
  'plan_file_too_large',
  'token_not_read_only',
  'github_unavailable',
  'rate_limited_by_github',
  'plan_source_too_large',
]);
/** The request client's own word for a spent budget; the import records it as `request_budget_exhausted`. */
const BUDGET_SPENT = 'request_budget_exceeded';

/** A failure the source (the GitHub client) raised, in the import's own codes. Anything else is `internal_error`. */
function codeOf(err: unknown): ImportErrorCode {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === BUDGET_SPENT) return 'request_budget_exhausted';
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
    let truncated = false;
    const finish = async (w: { level: ImportLevel; sourcePath: string | null; plan: ParsedPlan; computed: ComputedPlan; maxMergedPr: number; fallbackNote: string | null; itemProposals?: ItemProposal[] }, owner: OwnerProcess): Promise<ImportOutcome> => {
      const evidence = source.evidence();
      await writeSucceededImport(pool, principal, { importId, repoId, sourceSha: head.sha, owner, truncated, evidence, ...w });
      return { state: 'succeeded', importId, level: w.level, computed: w.computed, truncated, sourcePath: w.sourcePath, sourceSha: head.sha, maxMergedPr: w.maxMergedPr, evidence };
    };
    const hasLoop = async (): Promise<boolean> => (await source.file(ENGINE_LOOP_MARKER, head.sha, ENGINE_MARKER_MAX_BYTES)) !== null;
    /**
     * Only for the level 3 issues listing: it feeds no trust decision and no merged-pull-request count, so a budget that runs
     * out there ends the import as partial. Every other read lets the budget error through (the import fails closed).
     */
    const tolerant = async <T>(read: () => Promise<T>, empty: T): Promise<T> => {
      try {
        return await read();
      } catch (err) {
        if ((err as { code?: unknown } | null)?.code !== 'request_budget_exceeded') throw err;
        truncated = true;
        return empty;
      }
    };
    const cap = (plan: ParsedPlan): ParsedPlan => {
      if (plan.tasks.length <= MAX_PLAN_TASKS) return plan;
      // A bound is counted, never guessed: the first MAX_PLAN_TASKS tasks are kept and the import says it is partial.
      truncated = true;
      const keep = new Set(plan.tasks.slice(0, MAX_PLAN_TASKS).map((t) => t.key));
      return { milestones: plan.milestones.map((m) => ({ ...m, taskKeys: m.taskKeys.filter((k) => keep.has(k)) })), tasks: plan.tasks.slice(0, MAX_PLAN_TASKS) };
    };
    const countPulls = (pulls: readonly PullFacts[]): number => pulls.reduce((max, p) => (p.state === 'merged' && p.number > max ? p.number : max), 0);

    // Level 1: a roadmap file.
    let fallbackNote: string | null = null;
    for (const path of ROADMAP_PATHS) {
      const text = await source.file(path, head.sha, MAX_ROADMAP_BYTES);
      if (text === null) continue;
      let plan: ParsedPlan;
      try {
        plan = parseRoadmapFile(text);
      } catch (err) {
        if (err instanceof PlanFileShapeError) {
          fallbackNote = err.message;
          break;
        }
        if (err instanceof PlanFileInconsistentError) return await fail('plan_file_inconsistent', err.message);
        throw err;
      }
      plan = cap(plan);
      const owner = decideOwnerProcess({ repoHasEngineLoop: await hasLoop(), kind: 'task' });
      const read = await source.pulls();
      if (read.truncated) truncated = true;
      return await finish({ level: 'roadmap_file', sourcePath: path, plan, computed: computePlan(plan, read.pulls), maxMergedPr: countPulls(read.pulls), fallbackNote: null }, owner);
    }

    // Level 2: Spec task tables in the Discussions.
    const read = await source.discussions({ isSpec: isSpecDiscussion });
    // One permission lookup per distinct author for the whole import, shared by the Spec check and the Correction check.
    const permissions = memoizePermissions(source);
    // A Spec-shaped Discussion counts only when its author is trusted, decided before any of its comments are read.
    const specs = await trustedSpecDiscussions(read.specs, permissions);
    const comments = new Map<number, SpecComment[]>();
    for (const d of specs) {
      const c = await source.discussionComments(d.number, { isCorrection: isCorrectionComment });
      comments.set(d.number, c.comments);
    }
    const trusted = await trustedCorrectionAuthors(comments, permissions);
    const specPlan = cap(parseSpecTables(specs, comments, trusted));
    if (specPlan.tasks.length > 0) {
      const owner = decideOwnerProcess({ repoHasEngineLoop: await hasLoop(), kind: 'task' });
      const pulls = await source.pulls();
      if (pulls.truncated) truncated = true;
      return await finish({ level: 'spec_tables', sourcePath: null, plan: specPlan, computed: computePlan(specPlan, pulls.pulls), maxMergedPr: countPulls(pulls.pulls), fallbackNote }, owner);
    }

    // Level 3: issues and Discussions. Its own list of Discussions is bounded, and a cut there is a partial import.
    if (read.truncated) truncated = true;
    const issues = await tolerant(() => source.issues(), { issues: [], truncated: true });
    if (issues.truncated) truncated = true;
    const loop = await hasLoop();
    const level3 = buildIssuesLevel(issues.issues, read.discussions, loop);
    if (level3.truncated) truncated = true;
    return await finish({ level: 'issues_discussions', sourcePath: null, plan: { milestones: [], tasks: [] }, computed: level3.computed, maxMergedPr: 0, fallbackNote, itemProposals: level3.proposals }, decideOwnerProcess({ repoHasEngineLoop: loop, kind: 'task' }));
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
