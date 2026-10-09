/**
 * The ways a person gets a stuck work item moving, or ends it: Build again, Re-spec, Back to discussion, Treat as a feature,
 * Close and Reopen. ONE table for all of them, asked by the routes (@fx/api), by the activity read the Pipeline app draws its
 * buttons from, and by the tests. The Pipeline app keeps no rule of its own: it shows a button only when the server's
 * activity read lists the action.
 *
 * Build again is not decided here: it is the stage driver's own `rebuild` action (advance.ts, the Needs-a-person row),
 * so this file asks `advanceActionFor` and the two cannot disagree. The other three are rules of their own.
 *
 * Every move these actions make is a legal edge of the stage graph (stages.ts) and goes through `recordStage`; no edge
 * is added for them (a test pins each one against the graph).
 *
 * Pure: facts in, a verdict out.
 */
import type { PoolClient } from 'pg';
import { parseAcceptanceScope } from '../specs/acceptanceScope.js';
import { ADVANCE_PANEL_KINDS, advanceActionFor, type AdvanceFacts } from './advance.js';
import { isLegalStageTransition } from './stages.js';

/**
 * Every transition Back to discussion records has a source that starts with this. The panel and the Spec step count them to
 * know which panel this is (the first, or a new one asked for after a send-back), and the activity read shows only the
 * current panel's comments.
 */
export const BACK_TO_DISCUSSION_REF_PREFIX = 'back_to_discussion:';

export const OPERATOR_ACTIONS = ['build_again', 'respec', 'back_to_discussion', 'treat_as_feature', 'close', 'reopen'] as const;
export type OperatorAction = (typeof OPERATOR_ACTIONS)[number];

/**
 * The stages Close is offered at: an open item with no pull request, where `closed` is a legal edge. A merged item is
 * done, and a closed-unmerged one is already closed on GitHub; neither is "open".
 */
export const CLOSABLE_STAGES: readonly string[] = Object.freeze(['triaged', 'discussing', 'spec_ready', 'in_progress', 'needs_human']);

/**
 * Reopen is offered only at `closed`. `merged` and `closed_unmerged` are outcomes of a pull request, not a closing by a
 * person, so they are never reopened from here (the graph's `closed_unmerged -> in_progress` is the stage driver's own).
 */
export const REOPENABLE_STAGES: readonly string[] = Object.freeze(['closed']);

/**
 * The stages with an open pull request. The graph ends these in `closed_unmerged`, and closing the pull request on
 * GitHub already drives that through the webhook. So Close is NOT offered here (it would write a stage the pull request
 * contradicts, and leave it open on GitHub); the app says to close the pull request on GitHub instead.
 */
export const CLOSE_ON_GITHUB_STAGES: readonly string[] = Object.freeze(['pr_opened', 'changes_requested', 'review_passed']);

/** What the table needs to know about an item and the person asking. */
export interface OperatorFacts extends AdvanceFacts {
  provenance: string;
  repo_id: string | null;
  gh_number: string | number | null;
  /** Any agent run of the item is pending, running or paused. */
  live_run: boolean;
  /** The caller's role in the account. */
  role: string;
  /**
   * D#6 R4d-5b (C34 section 2.3): the newest unerased Spec version stores a file list the done check can read (the same parser). Re-spec is offered only
   * while this is false. False too when the item has no Spec (the table then refuses for that reason first).
   */
  spec_file_list_known: boolean;
}

export type OperatorRefusal = 'role' | 'external' | 'no_repo' | 'no_issue' | 'live' | 'stage' | 'state';
export type OperatorVerdict = { ok: true } | { ok: false; reason: OperatorRefusal; message: string };

const no = (reason: OperatorRefusal, message: string): OperatorVerdict => ({ ok: false, reason, message });

/** The actions the stage driver carries out (they need the repository and the issue behind the item). */
const DRIVEN: readonly OperatorAction[] = ['build_again', 'respec', 'back_to_discussion', 'treat_as_feature'];

/** Whether the caller may do `action` to the item now; or why not. The first refusal in this order wins: who, what, where, busy, stage. */
export function operatorVerdict(action: OperatorAction, f: OperatorFacts): OperatorVerdict {
  if (f.role !== 'owner' && f.role !== 'admin') return no('role', 'only an owner or an admin can do this');
  // Fail closed, as the intake gate does: only the exact literal "internal" is internal.
  if (f.provenance !== 'internal') return no('external', 'only an internal work item can be moved from here');
  if (DRIVEN.includes(action)) {
    if (f.repo_id === null) return no('no_repo', 'work item has no repository');
    if (f.gh_number === null) return no('no_issue', 'work item has no GitHub issue');
  }
  if (f.live_run) return no('live', 'agents are already working on this work item');
  const stageFacts = { stage: f.stage, discussion_id: f.discussion_id, kind: f.kind, has_spec: f.has_spec };
  switch (action) {
    case 'build_again': {
      const v = advanceActionFor(stageFacts);
      if (!v.ok) return no(v.reason, v.message);
      return v.action === 'rebuild' ? { ok: true } : no('stage', `work item is ${f.stage}`);
    }
    case 'respec': {
      // D#6 R4d-5b (C34 section 2.3): at Spec ready or Needs a person (the two stages a build can start from), when the latest Spec has no readable file list.
      // The stage and the buildable-kind rules are the build's own, asked of the one table, so the two cannot disagree about where a Spec is built.
      const v = advanceActionFor(stageFacts);
      if (!v.ok) return no(v.reason, v.message);
      if (v.action !== 'build' && v.action !== 'rebuild') return no('stage', `work item is ${f.stage}`);
      if (f.spec_file_list_known) return no('state', 'the latest Spec already has a file list');
      return { ok: true };
    }
    case 'back_to_discussion':
      if (f.stage !== 'needs_human' || !isLegalStageTransition(f.stage, 'discussing')) return no('stage', `work item is ${f.stage}`);
      if (f.discussion_id === null) return no('state', 'work item has no discussion');
      if (!f.has_spec) return no('state', 'work item has no published Spec');
      if (f.kind === null || !(ADVANCE_PANEL_KINDS as readonly string[]).includes(f.kind)) return no('state', `a ${f.kind ?? 'work item'} has no panel`);
      return { ok: true };
    case 'treat_as_feature':
      if (f.stage !== 'discussing') return no('stage', `work item is ${f.stage}`);
      if (f.discussion_id === null) return no('state', 'work item has no discussion');
      if (f.kind !== 'project') return no('state', `a ${f.kind ?? 'work item'} is not a project`);
      return { ok: true };
    case 'close':
      if (!CLOSABLE_STAGES.includes(f.stage) || !isLegalStageTransition(f.stage, 'closed')) return no('stage', `work item is ${f.stage}`);
      return { ok: true };
    case 'reopen':
      if (!REOPENABLE_STAGES.includes(f.stage) || !isLegalStageTransition(f.stage, 'triaged')) return no('stage', `work item is ${f.stage}`);
      return { ok: true };
  }
}

/** The actions the caller may do to the item right now, in the order the app draws them. */
export function operatorActionsFor(f: OperatorFacts): OperatorAction[] {
  return OPERATOR_ACTIONS.filter((a) => operatorVerdict(a, f).ok);
}

/** True when the item is internal, at a pull-request stage, and the caller is an owner or admin: the app tells them to close the pull request on GitHub. */
export function closeOnGithub(f: Pick<OperatorFacts, 'stage' | 'provenance' | 'role'>): boolean {
  return CLOSE_ON_GITHUB_STAGES.includes(f.stage) && f.provenance === 'internal' && (f.role === 'owner' || f.role === 'admin');
}

/**
 * Reads the facts the table needs, on a tenant-scoped client (RLS confines it to the caller's account). `lock` takes the
 * work item's row lock (`FOR UPDATE`), which `recordStage` takes too, so two people pressing at once are serialised and the
 * second sees the first's stage. Null when the item does not exist for this account.
 */
export async function readOperatorFacts(client: PoolClient, workItemId: string, role: string, lock = false): Promise<OperatorFacts | null> {
  const { rows } = await client.query<{ stage: string; provenance: string; repo_id: string | null; gh_number: string | null; discussion_id: string | null; kind: string | null; has_spec: boolean; acceptance_files: unknown; live_run: boolean }>(
    `SELECT w.stage, w.provenance, w.repo_id, w.gh_number, w.discussion_id, d.kind,
            EXISTS (SELECT 1 FROM spec_versions s WHERE s.work_item_id = w.id AND s.erased_at IS NULL) AS has_spec,
            (SELECT s.frontmatter -> 'acceptance_files' FROM spec_versions s WHERE s.work_item_id = w.id AND s.erased_at IS NULL ORDER BY s.version DESC LIMIT 1) AS acceptance_files,
            EXISTS (SELECT 1 FROM agent_runs r WHERE r.work_item_id = w.id AND r.status NOT IN ('succeeded', 'failed', 'timed_out', 'killed_spend', 'refused_spend', 'cancelled')) AS live_run
       FROM work_items w LEFT JOIN discussions d ON d.id = w.discussion_id
      WHERE w.id = $1::uuid${lock ? ' FOR UPDATE OF w' : ''}`,
    [workItemId],
  );
  const r = rows[0];
  if (!r) return null;
  const { acceptance_files: acceptanceFiles, ...rest } = r;
  return { ...rest, role, spec_file_list_known: parseAcceptanceScope(acceptanceFiles).kind === 'known' };
}
