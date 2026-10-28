import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SILENT_MS, STALE_WAIT_MS, STALL_ACTION_LABELS, STALL_STAGES, TRANSIENT_GATE_REASONS, classifyStall, stallActionLabel, type StallFacts } from '../src/work-items/stalled.js';

/**
 * R6: the pure half of the stalled-items list. Every kind of evidence, and every reason NOT to list an item (something is running, a question is open, a
 * request is in flight, the item is halted, it is waiting for a person by design). The database half, with real rows and the route, is
 * packages/api/test/stalled-items.test.ts.
 */
const NOW = new Date('2026-10-25T20:00:00.000Z');
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const MIN = 60_000;

function facts(over: Partial<StallFacts> = {}): StallFacts {
  return { stage: 'pr_opened', halted: false, liveRun: false, pendingRequest: false, waitingAsk: false, last: null, lastActivity: ago(5 * MIN), now: NOW, ...over };
}
const last = (kind: string, code: string | null = null, reasons: string[] = [], ageMs = 10 * MIN) => ({ kind, code, reasons, at: ago(ageMs) });

describe('R6: what counts as stalled', () => {
  it('a review that stopped because a reviewer could not start (live: the runner daily limit, cloud#673) is stalled, and says why', () => {
    const s = classifyStall(facts({ last: last('stopped', 'not_started_runner_daily_limit') }));
    expect(s).toMatchObject({ code: 'stopped' });
    expect(s!.why).toContain('daily limit');
  });

  it('an older stop that names the role instead of a reason still reads as a sentence', () => {
    const s = classifyStall(facts({ last: last('stopped', 'not_started_security_reviewer') }));
    expect(s!.why).toBe("A reviewer couldn't start (security reviewer), so the review stopped before it could finish.");
  });

  it('a merge gate answer that ended before the pull request could pass (live: draft, checks not green, public copy not open) is stalled', () => {
    const s = classifyStall(facts({ stage: 'review_passed', last: last('merge_gate', 'ready_human_merges', ['pr_draft', 'local_review_not_enabled', 'ci_not_green', 'public_pr_not_open']) }));
    expect(s).toMatchObject({ code: 'gate_not_ready' });
    expect(s!.why).toContain('pr draft, ci not green, public pr not open');
  });

  it('a gate answer that is really ready (only reasons no waiting clears) is not stalled: it is a pull request for a person to merge', () => {
    expect(classifyStall(facts({ stage: 'review_passed', last: last('merge_gate', 'ready_human_merges', ['local_review_not_enabled', 'local_reviews_passed_advisory']) }))).toBeNull();
    expect(classifyStall(facts({ stage: 'review_passed', last: last('merge_gate', 'ready_human_merges', ['auto_merge_not_allowed']) }))).toBeNull();
  });

  it.each(['build_refused', 'fix_round_refused', 'fix_round_failed', 'resume_refused'])('the newest fact %s is a stop', (kind) => {
    expect(classifyStall(facts({ stage: 'spec_ready', last: last(kind, 'no_model') }))).toMatchObject({ code: 'refused' });
  });

  it('a parent whose Spec plans several pull requests is refused its own build (parent_splits) and the card says so in a fixed sentence, never the code', () => {
    const s = classifyStall(facts({ stage: 'spec_ready', last: last('build_refused', 'parent_splits') }));
    expect(s).toMatchObject({ code: 'refused' });
    expect(s!.why).toBe('This Spec is split into several pull requests, so this item is not built itself. Each planned pull request is built as its own item once the Spec is approved.');
  });

  it('an escalation to a person is a stop, in words', () => {
    const s = classifyStall(facts({ stage: 'needs_human', last: last('escalated', 'max_fix_rounds') }));
    expect(s).toMatchObject({ code: 'handed_over' });
    expect(s!.why).toContain('fix rounds');
  });

  it('a needs-a-person item with no fact at all is still a stop whose workflow ended', () => {
    expect(classifyStall(facts({ stage: 'needs_human' }))).toMatchObject({ code: 'needs_person' });
  });

  it('a wait that is not being refreshed any more is stalled; a fresh one is a workflow (or the sweep) still looking', () => {
    expect(classifyStall(facts({ stage: 'spec_ready', last: last('stage_waiting', 'one_build_per_repo_until_d598', [], STALE_WAIT_MS + MIN) }))).toMatchObject({ code: 'wait_stale' });
    expect(classifyStall(facts({ stage: 'spec_ready', last: last('stage_waiting', 'one_build_per_repo_until_d598', [], STALE_WAIT_MS - MIN) }))).toBeNull();
  });

  it('silence longer than the longest silent wait (the two-hour CI wait) is stalled; shorter is a workflow waiting for checks', () => {
    expect(classifyStall(facts({ last: last('review_started'), lastActivity: ago(SILENT_MS + MIN) }))).toMatchObject({ code: 'silent' });
    expect(classifyStall(facts({ last: last('review_started'), lastActivity: ago(SILENT_MS - MIN) }))).toBeNull();
    // CI waits up to two hours; the silence bound must clear it.
    expect(SILENT_MS).toBeGreaterThan(2 * 60 * MIN);
  });

  it('a merge gate answer that is a fine place to sit is never silence, however old: ready for a person, merge handed to the runner, a merge order waiting', () => {
    const aged = SILENT_MS + 60 * MIN;
    for (const [code, reasons] of [['ready_human_merges', ['local_review_not_enabled']], ['merge_delegated', []], ['merge_queue_waiting', []], ['ready_human_merges', ['auto_merge_not_allowed']]] as const) {
      expect(classifyStall(facts({ stage: 'review_passed', last: last('merge_gate', code, [...reasons], aged), lastActivity: ago(aged) }))).toBeNull();
    }
    // The transient answer is still a stop at any age.
    expect(classifyStall(facts({ stage: 'review_passed', last: last('merge_gate', 'ready_human_merges', ['ci_not_green'], aged), lastActivity: ago(aged) }))).toMatchObject({ code: 'gate_not_ready' });
  });

  it('a Spec ready feature waiting for its Approve is not stalled, however long it waits: a person is the next step by design', () => {
    expect(classifyStall(facts({ stage: 'spec_ready', last: null, lastActivity: ago(30 * 24 * 60 * MIN) }))).toBeNull();
  });

  it.each([
    ['an agent is working on it', { liveRun: true }],
    ['a question is waiting for an answer', { waitingAsk: true }],
    ['a request of a person is in flight', { pendingRequest: true }],
    ['the item was halted', { halted: true }],
  ] as const)('not stalled while %s, whatever the newest fact says', (_why, over) => {
    expect(classifyStall(facts({ ...over, last: last('stopped', 'not_started_runner_daily_limit') }))).toBeNull();
  });

  it('the stop that is only "waiting on an answer" is the ask, not a stall', () => {
    expect(classifyStall(facts({ last: last('stopped', 'waiting_on_answer') }))).toBeNull();
  });

  it('terminal and early stages are never listed', () => {
    for (const stage of ['triaged', 'discussing', 'merged', 'closed', 'closed_unmerged']) expect(classifyStall(facts({ stage, last: last('stopped', 'x') }))).toBeNull();
  });
});

describe('R6: the action is the card\'s top button', () => {
  const base = { discussionId: 'd', kind: 'small', hasSpec: true, noVerdictHold: false };

  it('names the same button the Pipeline app draws at each stage', () => {
    const src = readFileSync(new URL('../../../apps/workspace/apps/pipeline/pipeline-actions.js', import.meta.url), 'utf8');
    const block = /export const LABELS = \{([^}]*)\}/.exec(src)![1]!;
    // Spec ready's label is the app's APPROVE_BUILD_LABEL constant; the others are written in the table.
    expect(block).toContain('spec_ready: APPROVE_BUILD_LABEL');
    expect(src).toContain(`APPROVE_BUILD_LABEL = "${STALL_ACTION_LABELS.spec_ready}"`);
    for (const [stage, label] of Object.entries(STALL_ACTION_LABELS)) if (stage !== 'spec_ready') expect(block).toContain(`${stage}: "${label}"`);
    for (const stage of ['spec_ready', 'in_progress', 'pr_opened', 'changes_requested', 'review_passed']) expect(stallActionLabel(stage, base)).toBe(STALL_ACTION_LABELS[stage]);
  });

  it('at Needs a person it is the stage driver\'s own choice: Build again, or the review when a reviewer kept ending without a verdict', () => {
    expect(stallActionLabel('needs_human', base)).toBe('Build again');
    expect(stallActionLabel('needs_human', { ...base, noVerdictHold: true })).toBe('Continue the review');
  });

  it('is null where the driver cannot advance (no Spec to build from), so the row offers nothing it would refuse', () => {
    expect(stallActionLabel('needs_human', { ...base, hasSpec: false })).toBeNull();
    expect(stallActionLabel('pr_opened', { ...base, hasSpec: false })).toBeNull();
    expect(stallActionLabel('spec_ready', { ...base, kind: 'question' })).toBeNull();
  });

  it('every stage the list reads is one the driver\'s table knows or is the labelled Needs a person', () => {
    for (const stage of STALL_STAGES) expect(stage === 'needs_human' || STALL_ACTION_LABELS[stage] !== undefined).toBe(true);
    expect(TRANSIENT_GATE_REASONS).toContain('public_pr_not_open');
  });
});
