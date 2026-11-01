import type { Pool } from 'pg';
import { assertActiveMembership } from '../tenancy/scopedAccess.js';
import { withTenant } from '../tenancy/withTenant.js';
import { advanceActionFor } from './advance.js';
import { blockingReasons, isQueuedSql } from './mergeReadiness.js';
import { readReviewHold } from './reviewHold.js';
import { cleanWorkItemTitle } from './title.js';

/**
 * Stalled items: an item whose stage expects the pipeline to carry on by itself, but whose workflow has ended (or is parked) with no run live, no question
 * waiting for an answer and no request of a person in flight. Nothing is stored for this list. An item is on it while the facts below hold, so the row
 * leaves by itself when the item moves, a run starts, or a person answers.
 *
 * Three kinds of evidence, strongest first:
 *   1. The newest driver fact is one the workflow writes on its way out: it stopped (`stopped`), handed over (`escalated`), or a start was refused or failed
 *      (`build_refused`, `fix_round_refused`, `fix_round_failed`, `resume_refused`).
 *   2. The newest fact is a merge gate answer "ready, a person merges" whose reasons include one that is not "a person presses merge" (the pull request is a draft, its
 *      checks are not green yet, the public copy is not open yet, a review did not pass: mergeReadiness.ts). The workflow ended on that answer and nothing asks the gate again.
 *   3. The newest fact is a wait (`stage_waiting`) that stopped being refreshed: a live workflow refreshes it at every ask, and the parked-stage sweep does
 *      while a limit still denies the start, so a stale one means neither is looking.
 *   4. At a stage with a workflow in flight, nothing at all happened for longer than the longest wait a workflow makes silently (the two-hour CI wait).
 *
 * The action is the card's own top button: it is the stage driver's table (advance.ts) that says what pressing it does, and the Pipeline app's labels
 * name it. This file adds no authority; the row's button calls the same approve route.
 */

/** The stages whose next step is the pipeline's own, plus Needs a person (a stop whose workflow has ended). */
export const STALL_STAGES: readonly string[] = Object.freeze(['spec_ready', 'in_progress', 'pr_opened', 'changes_requested', 'review_passed', 'needs_human']);

/** Stages at which a workflow is normally in flight, so silence is itself the evidence (evidence kind 4). */
const SILENT_STAGES: readonly string[] = Object.freeze(['in_progress', 'pr_opened', 'changes_requested', 'review_passed']);

/** A wait fact older than this is not being refreshed (workflows refresh every minute or five; the sweep every fifteen). */
export const STALE_WAIT_MS = 30 * 60_000;
/** Longer than the longest silent wait of a workflow (the two-hour CI wait) plus a margin. */
export const SILENT_MS = 150 * 60_000;

/**
 * Gate reasons that time or a later step can clear: the pull request is still a draft, its checks have not finished, or the public copy is not open yet.
 * A gate answer with one of these is not "ready": it ended before it could pass, and it is asked again by the event that clears the reason (packages/worker gateReask.ts), or by pressing the card's button.
 */
export const TRANSIENT_GATE_REASONS: readonly string[] = Object.freeze(['pr_draft', 'ci_not_green', 'public_pr_not_open', 'public_head_unrecorded', 'merge_queue_unreadable']);

/** D#694 B5: gate reasons with a sentence of their own (every other code is shown with its underscores as spaces). */
const GATE_REASON_WORDS: Readonly<Record<string, string>> = Object.freeze({
  merge_queue_unreadable: "GitHub's merge queue state could not be read; try again or merge by hand",
});

/** The label of the card's top button, per stage (the Pipeline app's own words; a test pins the two lists equal). */
export const STALL_ACTION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  spec_ready: 'Approve the Spec and build',
  in_progress: 'Check the build',
  pr_opened: 'Approve and review',
  changes_requested: 'Continue the review',
  review_passed: 'Check the merge',
});

/** Code words that read badly as a sentence; every other code is shown with its underscores as spaces. */
const STOP_WORDS: Readonly<Record<string, string>> = Object.freeze({
  not_started_runner_daily_limit: "A reviewer couldn't start because the runner's daily limit was reached, so the review stopped before it could finish.",
  review: 'The review stopped before it could finish.',
  review_quiet_period_unsettled: 'The review was still waiting for the pull request to stop changing when the pipeline gave up waiting.',
  reviewer_not_started: "A reviewer couldn't start, so the review stopped before it could finish.",
  merge_gate: 'The merge check stopped before it could decide.',
  merge_queue_retry_used: "GitHub's merge queue removed this pull request again after the one automatic retry, so the pipeline stopped for a person.",
  review_key_missing: 'The review needs a model key and there is none, so it did not start.',
  build_no_pull_request: 'The build finished without opening a pull request.',
  build_wait_timeout: 'The build ran out of time and was stopped.',
  build_check_rounds_used: "The build's checks kept failing and the automatic fixes are used up.",
  max_fix_rounds: 'The reviewers asked for changes more times than the automatic fix rounds allow.',
  fix_no_change_repeated: "Two fix rounds in a row changed nothing, so the pipeline stopped trying.",
  reviewer_fail: 'A reviewer could not approve this change.',
  reviewer_no_verdict: 'A reviewer kept ending without a verdict.',
  reviewer_unverifiable: 'A reviewer could not check some of the criteria in its environment.',
  reviewer_environment: 'A reviewer could not run the tests.',
  wait_timeout: 'A fix round ran out of time and was stopped.',
  halted: 'The work was halted.',
  parent_has_children: 'This item still has planned pull requests in progress, so the new Spec does not build it. They stay as they are: decide what happens to them, then start the work again.',
  parent_splits: 'This Spec is split into several pull requests, so this item is not built itself. Each planned pull request is built as its own item once the Spec is approved.',
});

/** D#694 B6-3: fixed words for a pull request GitHub's merge queue took out and nothing has put back. No text from GitHub is in it. */
export const DEQUEUED_SENTENCE = "GitHub's merge queue removed this pull request and it has not been put back in the queue.";

const humanise = (code: string): string => code.replace(/_/g, ' ');

export interface StallFacts {
  stage: string;
  halted: boolean;
  liveRun: boolean;
  pendingRequest: boolean;
  waitingAsk: boolean;
  /** The newest driver fact, or null when the item has none. */
  last: { kind: string; code: string | null; reasons: readonly string[]; at: Date } | null;
  /** The newest sign of life: a driver fact, a run, or the item itself. */
  lastActivity: Date;
  now: Date;
  /** D#694 B6-3: the item is waiting in GitHub's merge queue (derived, mergeReadiness.ts). Absent reads as false. */
  queued?: boolean;
}

export interface Stall {
  /** A closed code for the evidence: `stopped`, `handed_over`, `refused`, `gate_not_ready`, `wait_stale`, `silent`, `needs_person`. */
  code: string;
  /** What stopped, in the cloud's own plain words. No text from a model or an issue is in it. */
  why: string;
  since: Date;
}

const REFUSAL_KINDS: readonly string[] = ['build_refused', 'fix_round_refused', 'fix_round_failed', 'resume_refused'];

function minutes(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 90) return `${m} minutes`;
  return `${Math.round(m / 60)} hours`;
}

/** Pure: whether the facts describe a stalled item, and what to say about it. */
export function classifyStall(f: StallFacts): Stall | null {
  if (!STALL_STAGES.includes(f.stage)) return null;
  if (f.halted || f.liveRun || f.pendingRequest || f.waitingAsk) return null;
  const last = f.last;
  const sentenceFor = (code: string | null, fallback: string): string => {
    if (code !== null && STOP_WORDS[code] !== undefined) return STOP_WORDS[code]!;
    // `not_started_<reason>`: a reviewer was refused at the start (older facts end in the reviewer's role instead of a reason).
    if (code !== null && code.startsWith('not_started_')) return `A reviewer couldn't start (${humanise(code.slice('not_started_'.length))}), so the review stopped before it could finish.`;
    return code !== null ? `${fallback} (${humanise(code)}).` : `${fallback}.`;
  };

  if (last !== null && last.kind === 'stopped' && last.code !== 'waiting_on_answer') {
    return { code: 'stopped', why: sentenceFor(last.code, 'The pipeline stopped'), since: last.at };
  }
  if (last !== null && last.kind === 'escalated') {
    return { code: 'handed_over', why: sentenceFor(last.code, 'The pipeline handed this to a person'), since: last.at };
  }
  if (last !== null && REFUSAL_KINDS.includes(last.kind)) {
    const base = last.kind === 'build_refused' ? "The build couldn't start" : last.kind === 'fix_round_failed' ? 'The fix round ended without finishing' : last.kind === 'resume_refused' ? "The work couldn't be resumed" : "The fix round couldn't start";
    return { code: 'refused', why: sentenceFor(last.code, base), since: last.at };
  }
  // D#694 B6-3: waiting in GitHub's merge queue is active work, however many other facts were written after the enqueue (B6-4 bounds how long).
  if (f.queued === true) return null;
  // A removal nothing has answered: a person's is a stop at once; GitHub's own is the pipeline's turn to queue it again (one automatic retry), so it is given the stale-wait time first.
  if (last !== null && last.kind === 'merge_dequeued' && (last.reasons.includes('actor_user') || f.now.getTime() - last.at.getTime() > STALE_WAIT_MS)) {
    return { code: 'dequeued', why: DEQUEUED_SENTENCE, since: last.at };
  }
  if (last !== null && last.kind === 'merge_gate' && last.code === 'ready_human_merges') {
    const transient = blockingReasons(last.reasons);
    if (transient.length > 0) {
      return {
        code: 'gate_not_ready',
        why: `The merge check ran before the pull request was ready (${transient.map((r) => GATE_REASON_WORDS[r] ?? humanise(r)).join(', ')}) and it was not asked again.`,
        since: last.at,
      };
    }
  }
  // Any other merge gate answer is a legitimate place to sit, however long: a pull request ready for a person (it has its own row in the merge-ready list),
  // a merge handed to the runner or waiting in the merge queue (ours, or GitHub's: `merge_enqueued`), a merge order the runner has not finished. None of them is silence.
  if (last !== null && (last.kind === 'merge_gate' || last.kind === 'merge_enqueued')) return null;
  if (last !== null && last.kind === 'stage_waiting' && f.now.getTime() - last.at.getTime() > STALE_WAIT_MS) {
    return { code: 'wait_stale', why: `This was waiting for a limit or a free slot, but nothing has asked again for ${minutes(f.now.getTime() - last.at.getTime())}.`, since: last.at };
  }
  if (f.stage === 'needs_human') {
    // A stop whose workflow has ended. The newest fact, when there is one, was handled above; this is the stage's own word.
    return { code: 'needs_person', why: 'The pipeline stopped here and is waiting for a person to decide what happens next.', since: last?.at ?? f.lastActivity };
  }
  if (SILENT_STAGES.includes(f.stage) && f.now.getTime() - f.lastActivity.getTime() > SILENT_MS) {
    return { code: 'silent', why: `Nothing has happened for ${minutes(f.now.getTime() - f.lastActivity.getTime())} and no agent is working on it.`, since: f.lastActivity };
  }
  return null;
}

export interface StalledItem {
  workItemId: string;
  title: string | null;
  stage: string;
  code: string;
  why: string;
  /** The card's top button for this stage, or null when no automatic step applies (a person has to choose another action on the card). */
  actionLabel: string | null;
  since: Date;
}

export interface StalledCtx {
  pool: Pool;
  principal: { accountId: string; userId: string; tokenId?: string };
}

interface Row {
  id: string;
  title: string | null;
  stage: string;
  kind: string | null;
  discussion_id: string | null;
  has_spec: boolean;
  halted: boolean;
  live_run: boolean;
  pending_request: boolean;
  waiting_ask: boolean;
  last_kind: string | null;
  last_code: string | null;
  last_reasons: string[] | null;
  last_at: Date | null;
  last_activity: Date;
  queued: boolean;
}

/** The label for the card's top button at this stage, asked of the stage driver's own table; null when it does not advance here. */
export function stallActionLabel(stage: string, facts: { discussionId: string | null; kind: string | null; hasSpec: boolean; noVerdictHold: boolean }): string | null {
  const verdict = advanceActionFor({ stage, discussion_id: facts.discussionId, kind: facts.kind, has_spec: facts.hasSpec, no_verdict_hold: facts.noVerdictHold });
  if (!verdict.ok) return null;
  if (stage === 'needs_human') return verdict.action === 'review' ? 'Continue the review' : 'Build again';
  return STALL_ACTION_LABELS[stage] ?? null;
}

/** Oldest stop first would bury the new ones: newest first. `total` counts every stalled item, shown or not. */
export async function listStalledItems(ctx: StalledCtx, opts: { limit: number; now?: Date }): Promise<{ items: StalledItem[]; total: number }> {
  if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > 500) throw new RangeError('listStalledItems: limit must be 1..500');
  const { accountId, userId, tokenId } = ctx.principal;
  const now = opts.now ?? new Date();
  const rows = await withTenant(ctx.pool, accountId, userId, tokenId, async (client) => {
    await assertActiveMembership(client, accountId, userId);
    const res = await client.query<Row>(
      `SELECT w.id, w.title, w.stage, d.kind, w.discussion_id,
              EXISTS (SELECT 1 FROM spec_versions s WHERE s.work_item_id = w.id AND s.erased_at IS NULL) AS has_spec,
              w.halted_at IS NOT NULL AS halted,
              EXISTS (SELECT 1 FROM agent_runs r WHERE r.work_item_id = w.id AND r.status NOT IN ('succeeded', 'failed', 'timed_out', 'killed_spend', 'refused_spend', 'cancelled')) AS live_run,
              EXISTS (SELECT 1 FROM run_action_requests q WHERE q.target_id = w.id AND q.state IN ('accepted', 'claimed')) AS pending_request,
              EXISTS (SELECT 1 FROM decision_asks a WHERE a.work_item_id = w.id AND a.state IN ('open', 'overdue')) AS waiting_ask,
              e.kind AS last_kind, e.code AS last_code, e.reasons AS last_reasons, e.created_at AS last_at,
              ${isQueuedSql('w.account_id', 'w.id')} AS queued,
              GREATEST(w.updated_at, e.created_at, (SELECT max(r.updated_at) FROM agent_runs r WHERE r.work_item_id = w.id)) AS last_activity
         FROM work_items w
         LEFT JOIN discussions d ON d.id = w.discussion_id
         LEFT JOIN LATERAL (SELECT v.kind, v.code, v.reasons, v.created_at FROM work_item_driver_events v
                             WHERE v.account_id = w.account_id AND v.work_item_id = w.id ORDER BY v.seq DESC LIMIT 1) e ON true
        WHERE w.account_id = $1::uuid AND w.provenance = 'internal' AND w.repo_id IS NOT NULL AND w.gh_number IS NOT NULL AND w.stage = ANY($2::text[])`,
      [accountId, [...STALL_STAGES]],
    );
    // Needs a person holds for a missing verdict (Approve re-enters the review) or is a build to run again: the one definition the approve route uses.
    const holds = new Set<string>();
    for (const r of res.rows) if (r.stage === 'needs_human' && (await readReviewHold(client, r.id))) holds.add(r.id);
    return res.rows.map((r) => ({ ...r, hold: holds.has(r.id) }));
  });
  const found: StalledItem[] = [];
  for (const r of rows) {
    const stall = classifyStall({
      stage: r.stage,
      halted: r.halted,
      liveRun: r.live_run,
      pendingRequest: r.pending_request,
      waitingAsk: r.waiting_ask,
      last: r.last_kind === null || r.last_at === null ? null : { kind: r.last_kind, code: r.last_code, reasons: r.last_reasons ?? [], at: r.last_at },
      lastActivity: r.last_activity,
      now,
      queued: r.queued,
    });
    if (stall === null) continue;
    found.push({
      workItemId: r.id,
      title: cleanWorkItemTitle(r.title),
      stage: r.stage,
      code: stall.code,
      why: stall.why,
      actionLabel: stallActionLabel(r.stage, { discussionId: r.discussion_id, kind: r.kind, hasSpec: r.has_spec, noVerdictHold: r.hold }),
      since: stall.since,
    });
  }
  found.sort((a, b) => b.since.getTime() - a.since.getTime() || a.workItemId.localeCompare(b.workItemId));
  return { items: found.slice(0, opts.limit), total: found.length };
}
