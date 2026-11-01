import { describe, expect, it } from 'vitest';
import { loadPlanData } from '@fx/plan-data';
import { WORK_ITEM_STAGES, WORK_ITEM_STAGE_TRANSITIONS, isLegalStageTransition } from '../src/work-items/stages.js';
import { advanceActionFor } from '../src/work-items/advance.js';
import {
  CLOSABLE_STAGES,
  CLOSE_ON_GITHUB_STAGES,
  OPERATOR_ACTIONS,
  closeOnGithub,
  operatorActionsFor,
  operatorVerdict,
  type OperatorFacts,
} from '../src/work-items/operatorActions.js';

/** The four ways a person moves a stuck work item. One table; the routes, the activity read and the Pipeline app's buttons all ask it. */
const BASE: OperatorFacts = { stage: 'needs_human', discussion_id: 'd', kind: 'feature', has_spec: true, provenance: 'internal', repo_id: 'r', gh_number: '12', live_run: false, role: 'admin', spec_file_list_known: true };
const at = (over: Partial<OperatorFacts>): OperatorFacts => ({ ...BASE, ...over });

describe('Re-spec (D#6 R4d-5b, C34 section 2.3)', () => {
  const noList = (over: Partial<OperatorFacts> = {}) => at({ spec_file_list_known: false, ...over });

  it('is offered at Spec ready and at Needs a person when the newest Spec has no readable list, and only then', () => {
    expect(operatorActionsFor(noList({ stage: 'spec_ready' }))).toEqual(['respec', 'close']);
    expect(operatorActionsFor(noList())).toEqual(['build_again', 'respec', 'back_to_discussion', 'close']);
    expect(operatorActionsFor(at({ stage: 'spec_ready' }))).toEqual(['close']);
    expect(operatorActionsFor(at({}))).not.toContain('respec');
  });

  it('is not offered at any other stage, without a Spec, for an unbuilt kind, for a member, an external item, a missing repo or issue, or a live run', () => {
    for (const stage of ['triaged', 'discussing', 'in_progress', 'pr_opened', 'merged', 'closed']) expect(operatorVerdict('respec', noList({ stage })), stage).toMatchObject({ ok: false });
    expect(operatorVerdict('respec', noList({ has_spec: false }))).toMatchObject({ ok: false });
    expect(operatorVerdict('respec', noList({ kind: 'question' }))).toMatchObject({ ok: false });
    expect(operatorVerdict('respec', noList({ role: 'member' }))).toMatchObject({ ok: false, reason: 'role' });
    expect(operatorVerdict('respec', noList({ provenance: 'external' }))).toMatchObject({ ok: false, reason: 'external' });
    expect(operatorVerdict('respec', noList({ repo_id: null }))).toMatchObject({ ok: false, reason: 'no_repo' });
    expect(operatorVerdict('respec', noList({ gh_number: null }))).toMatchObject({ ok: false, reason: 'no_issue' });
    expect(operatorVerdict('respec', noList({ live_run: true }))).toMatchObject({ ok: false, reason: 'live' });
  });

  it('is refused (state) once the newest Spec has a list, so a second press after a success changes nothing', () => {
    expect(operatorVerdict('respec', at({ spec_file_list_known: true }))).toMatchObject({ ok: false, reason: 'state' });
  });
});

describe('operatorVerdict / operatorActionsFor', () => {
  it('a Needs-a-person feature with a Spec offers Build again, Back to discussion and Close, in that order', () => {
    expect(operatorActionsFor(BASE)).toEqual(['build_again', 'back_to_discussion', 'close']);
  });

  it('a discussing project offers Treat as a feature and Close', () => {
    expect(operatorActionsFor(at({ stage: 'discussing', kind: 'project', has_spec: false }))).toEqual(['treat_as_feature', 'close']);
  });

  it.each(['small', 'bug', 'doc'])('a Needs-a-person %s offers Build again but not Back to discussion (no panel)', (kind) => {
    expect(operatorActionsFor(at({ kind }))).toEqual(['build_again', 'close']);
  });

  it.each(['project', 'question'])('a Needs-a-person %s has no Spec worth building: Close only', (kind) => {
    expect(operatorActionsFor(at({ kind }))).toEqual(['close']);
  });

  it('Needs a person with no published Spec offers Close only', () => {
    expect(operatorActionsFor(at({ has_spec: false }))).toEqual(['close']);
  });

  it.each(['triaged', 'spec_ready', 'in_progress'])('%s offers Close and nothing else', (stage) => {
    expect(operatorActionsFor(at({ stage }))).toEqual(['close']);
  });

  it('a discussing feature offers Close only (Try the Spec again is Approve)', () => {
    expect(operatorActionsFor(at({ stage: 'discussing', has_spec: false }))).toEqual(['close']);
  });

  it.each([...CLOSE_ON_GITHUB_STAGES, 'merged', 'closed_unmerged'])('%s offers nothing', (stage) => {
    expect(operatorActionsFor(at({ stage }))).toEqual([]);
  });

  it('a closed item offers Reopen and nothing else; merged and closed_unmerged never offer it', () => {
    expect(operatorActionsFor(at({ stage: 'closed' }))).toEqual(['reopen']);
    for (const stage of ['merged', 'closed_unmerged', 'triaged', 'needs_human', 'pr_opened']) expect(operatorVerdict('reopen', at({ stage })), stage).toMatchObject({ ok: false, reason: 'stage' });
    expect(operatorVerdict('reopen', at({ stage: 'closed', role: 'member' }))).toMatchObject({ ok: false, reason: 'role' });
    expect(operatorVerdict('reopen', at({ stage: 'closed', provenance: 'external' }))).toMatchObject({ ok: false, reason: 'external' });
    expect(operatorVerdict('reopen', at({ stage: 'closed', live_run: true }))).toMatchObject({ ok: false, reason: 'live' });
    expect(isLegalStageTransition('closed', 'triaged')).toBe(true);
  });

  it.each(['member', 'viewer', '', 'OWNER'])('role "%s" is offered nothing', (role) => {
    expect(operatorActionsFor(at({ role }))).toEqual([]);
    expect(operatorVerdict('close', at({ role }))).toMatchObject({ ok: false, reason: 'role' });
  });

  it('owner and admin are alike', () => {
    expect(operatorActionsFor(at({ role: 'owner' }))).toEqual(operatorActionsFor(at({ role: 'admin' })));
  });

  it.each(['external', 'trusted', ''])('provenance "%s" is never internal: nothing is offered (fail closed)', (provenance) => {
    expect(operatorActionsFor(at({ provenance }))).toEqual([]);
    expect(operatorVerdict('close', at({ provenance }))).toMatchObject({ ok: false, reason: 'external' });
  });

  it('a live run offers nothing and says so', () => {
    expect(operatorActionsFor(at({ live_run: true }))).toEqual([]);
    for (const a of OPERATOR_ACTIONS) expect(operatorVerdict(a, at({ live_run: true })), a).toMatchObject({ ok: false, reason: 'live' });
  });

  it('the driver-run actions need the repository and the issue; Close does not', () => {
    expect(operatorVerdict('build_again', at({ repo_id: null }))).toMatchObject({ ok: false, reason: 'no_repo' });
    expect(operatorVerdict('back_to_discussion', at({ gh_number: null }))).toMatchObject({ ok: false, reason: 'no_issue' });
    expect(operatorVerdict('treat_as_feature', at({ stage: 'discussing', kind: 'project', repo_id: null }))).toMatchObject({ ok: false, reason: 'no_repo' });
    expect(operatorVerdict('close', at({ repo_id: null, gh_number: null }))).toEqual({ ok: true });
  });

  it('Treat as a feature is for a project only, at discussing', () => {
    for (const kind of ['feature', 'critical', 'bug', 'question', null]) {
      expect(operatorVerdict('treat_as_feature', at({ stage: 'discussing', kind })), String(kind)).toMatchObject({ ok: false, reason: 'state' });
    }
    expect(operatorVerdict('treat_as_feature', at({ stage: 'needs_human', kind: 'project' }))).toMatchObject({ ok: false, reason: 'stage' });
    expect(operatorVerdict('treat_as_feature', at({ stage: 'discussing', kind: 'project', discussion_id: null }))).toMatchObject({ ok: false, reason: 'state' });
  });

  it('Back to discussion is for a panel kind with a Spec, at needs_human', () => {
    for (const kind of ['small', 'bug', 'doc', 'project', 'question', null]) {
      expect(operatorVerdict('back_to_discussion', at({ kind })), String(kind)).toMatchObject({ ok: false, reason: 'state' });
    }
    expect(operatorVerdict('back_to_discussion', at({ has_spec: false }))).toMatchObject({ ok: false, reason: 'state' });
    expect(operatorVerdict('back_to_discussion', at({ discussion_id: null }))).toMatchObject({ ok: false, reason: 'state' });
    expect(operatorVerdict('back_to_discussion', at({ stage: 'discussing' }))).toMatchObject({ ok: false, reason: 'stage' });
  });

  it('Build again is the stage driver\'s own rebuild verdict, not a second rule', () => {
    for (const stage of WORK_ITEM_STAGES) {
      for (const kind of ['feature', 'project', 'bug', null]) {
        for (const has_spec of [true, false]) {
          const facts = at({ stage, kind, has_spec });
          const driver = advanceActionFor({ stage, discussion_id: 'd', kind, has_spec });
          expect(operatorVerdict('build_again', facts).ok, `${stage} ${kind} ${has_spec}`).toBe(driver.ok && driver.action === 'rebuild');
        }
      }
    }
  });

  it('messages are plain words (no undefined or null)', () => {
    for (const a of OPERATOR_ACTIONS) {
      for (const stage of WORK_ITEM_STAGES) {
        const v = operatorVerdict(a, at({ stage, kind: null }));
        if (!v.ok) expect(v.message, `${a} ${stage}`).not.toMatch(/undefined|null/);
      }
    }
  });
});

describe('the stage graph: no edge is added for these actions', () => {
  it('every stage Close is offered at has closed as a legal edge, and every stage it is not offered at that is open ends elsewhere', () => {
    for (const s of CLOSABLE_STAGES) expect(isLegalStageTransition(s, 'closed'), s).toBe(true);
    expect(CLOSABLE_STAGES).toEqual(['triaged', 'discussing', 'spec_ready', 'in_progress', 'needs_human']);
  });

  it('the pull-request stages have no closed edge: they end in closed_unmerged, which the webhook drives when the pull request is closed on GitHub', () => {
    for (const s of CLOSE_ON_GITHUB_STAGES) {
      expect(isLegalStageTransition(s, 'closed'), s).toBe(false);
      expect(isLegalStageTransition(s, 'closed_unmerged'), s).toBe(true);
    }
  });

  it('merged is done and closed_unmerged is already closed: Close is not offered, although the graph allows closed from both', () => {
    expect(isLegalStageTransition('merged', 'closed')).toBe(true);
    expect(isLegalStageTransition('closed_unmerged', 'closed')).toBe(true);
    expect(CLOSABLE_STAGES).not.toContain('merged');
    expect(CLOSABLE_STAGES).not.toContain('closed_unmerged');
  });

  it('Build again, Back to discussion and Treat as a feature ride edges the graph already has (needs_human to in_progress and to discussing; discussing to spec_ready)', () => {
    expect(WORK_ITEM_STAGE_TRANSITIONS.needs_human).toContain('in_progress');
    expect(WORK_ITEM_STAGE_TRANSITIONS.needs_human).toContain('discussing');
    expect(WORK_ITEM_STAGE_TRANSITIONS.discussing).toContain('spec_ready');
  });
});

describe('closeOnGithub', () => {
  it('is for an owner or admin looking at an internal item with an open pull request', () => {
    for (const stage of CLOSE_ON_GITHUB_STAGES) expect(closeOnGithub(at({ stage })), stage).toBe(true);
    expect(closeOnGithub(at({ stage: 'pr_opened', role: 'member' }))).toBe(false);
    expect(closeOnGithub(at({ stage: 'pr_opened', provenance: 'external' }))).toBe(false);
    expect(closeOnGithub(at({ stage: 'needs_human' }))).toBe(false);
  });
});

describe('retry_push and open_pr (D#598 P1f-6b)', () => {
  const push = (over: Partial<NonNullable<OperatorFacts['push']>> = {}) => at({ push: { state: 'refused', lastPushRuntime: 'sandbox', pushAttempts: 1, managedByPerson: false, ...over } });

  it('retry_push is offered for a refused push of a sandbox build with fewer than three attempts, and only then', () => {
    expect(operatorVerdict('retry_push', push())).toEqual({ ok: true });
    expect(operatorVerdict('retry_push', push({ pushAttempts: 2 }))).toEqual({ ok: true });
    for (const over of [{ pushAttempts: 3 }, { lastPushRuntime: 'runner' as const }, { state: 'pr_opened' as const }, { state: 'pushed_pr_not_opened' as const }, { managedByPerson: true }]) {
      expect(operatorVerdict('retry_push', push(over)), JSON.stringify(over)).toMatchObject({ ok: false, reason: 'state' });
    }
    expect(operatorVerdict('retry_push', at({}))).toMatchObject({ ok: false, reason: 'state' });
    expect(operatorVerdict('retry_push', at({ push: null }))).toMatchObject({ ok: false, reason: 'state' });
  });

  it('open_pr is offered only for a pushed branch with no pull request that nobody has taken over', () => {
    expect(operatorVerdict('open_pr', push({ state: 'pushed_pr_not_opened' }))).toEqual({ ok: true });
    for (const over of [{ state: 'refused' as const }, { state: 'pushed' as const }, { state: 'pr_opened' as const }, { state: 'pushed_pr_not_opened' as const, managedByPerson: true }]) {
      expect(operatorVerdict('open_pr', push(over)), JSON.stringify(over)).toMatchObject({ ok: false, reason: 'state' });
    }
  });

  it('owner or admin only; a live run (a publish run included) answers live, so a second press is already_running', () => {
    expect(operatorVerdict('retry_push', { ...push(), role: 'member' })).toMatchObject({ ok: false, reason: 'role' });
    expect(operatorVerdict('open_pr', { ...push({ state: 'pushed_pr_not_opened' }), role: 'member' })).toMatchObject({ ok: false, reason: 'role' });
    expect(operatorVerdict('retry_push', { ...push(), role: 'owner' })).toEqual({ ok: true });
    expect(operatorVerdict('retry_push', { ...push(), live_run: true })).toMatchObject({ ok: false, reason: 'live' });
    expect(operatorVerdict('open_pr', { ...push({ state: 'pushed_pr_not_opened' }), live_run: true })).toMatchObject({ ok: false, reason: 'live' });
  });

  it('they come last in the list, after the stuck-item actions', () => {
    expect(OPERATOR_ACTIONS.slice(-4, -2)).toEqual(['retry_push', 'open_pr']);
    expect(operatorActionsFor(push())).toEqual(['build_again', 'back_to_discussion', 'close', 'retry_push']);
  });
});

describe('Remove from queue and Queue again (D#694 B6-5)', () => {
  const q = (merge_queue: OperatorFacts['merge_queue'], over: Partial<OperatorFacts> = {}) => at({ stage: 'review_passed', merge_queue, ...over });

  it('Remove from queue is offered only while the item waits in the queue, Queue again only after the queue took it out; never both, never neither unless there is nothing to do', () => {
    expect(operatorActionsFor(q('queued'))).toContain('remove_from_queue');
    expect(operatorActionsFor(q('queued'))).not.toContain('queue_again');
    expect(operatorActionsFor(q('removed'))).toContain('queue_again');
    expect(operatorActionsFor(q('removed'))).not.toContain('remove_from_queue');
    for (const none of [null, undefined, 'not_in_queue'] as const) {
      expect(operatorActionsFor(q(none)), String(none)).not.toContain('remove_from_queue');
      expect(operatorActionsFor(q(none)), String(none)).not.toContain('queue_again');
    }
  });

  it('Queue again is also offered when the host stayed silent (no_answer), and at Needs a person only when the queue put it there', () => {
    expect(operatorActionsFor(q('no_answer'))).toContain('queue_again');
    expect(operatorActionsFor(q('no_answer'))).not.toContain('remove_from_queue');
    const held = (merge_queue: OperatorFacts['merge_queue'], queue_hold?: boolean) => q(merge_queue, { stage: 'needs_human', queue_hold });
    expect(operatorVerdict('queue_again', held('no_answer', true))).toEqual({ ok: true });
    expect(operatorVerdict('queue_again', held('removed', true))).toEqual({ ok: true });
    expect(operatorVerdict('queue_again', held('removed', false))).toMatchObject({ ok: false });
    expect(operatorVerdict('queue_again', held('removed', undefined))).toMatchObject({ ok: false });
    expect(operatorVerdict('queue_again', held('queued', true))).toMatchObject({ ok: false });
  });

  it('neither is offered at another stage, to a member, for an external item, or while an agent runs; Queue again also needs the repository and the issue (it asks the driver)', () => {
    for (const stage of ['pr_opened', 'changes_requested', 'needs_human', 'merged', 'closed']) {
      expect(operatorVerdict('remove_from_queue', q('queued', { stage })), stage).toMatchObject({ ok: false });
      expect(operatorVerdict('queue_again', q('removed', { stage })), stage).toMatchObject({ ok: false });
    }
    expect(operatorVerdict('remove_from_queue', q('queued', { role: 'member' }))).toMatchObject({ ok: false, reason: 'role' });
    expect(operatorVerdict('queue_again', q('removed', { provenance: 'external' }))).toMatchObject({ ok: false, reason: 'external' });
    expect(operatorVerdict('remove_from_queue', q('queued', { live_run: true }))).toMatchObject({ ok: false, reason: 'live' });
    expect(operatorVerdict('queue_again', q('removed', { repo_id: null }))).toMatchObject({ ok: false, reason: 'no_repo' });
    expect(operatorVerdict('queue_again', q('removed', { gh_number: null }))).toMatchObject({ ok: false, reason: 'no_issue' });
  });
});

describe('Request changes', () => {
  const max = loadPlanData().caps.maxFixRounds;
  const pr = (over: Partial<OperatorFacts> = {}) => at({ stage: 'review_passed', pr_open: true, fix_rounds_started: 0, ...over });

  it.each(['pr_opened', 'changes_requested', 'review_passed'])('is offered at %s with an open pull request, a Spec and a fix round left, first in the list', (stage) => {
    expect(operatorVerdict('request_changes', pr({ stage }))).toEqual({ ok: true });
    expect(operatorActionsFor(pr({ stage }))[0]).toBe('request_changes');
  });

  it('is offered at Needs a person only while its pull request is still open', () => {
    expect(operatorVerdict('request_changes', pr({ stage: 'needs_human' }))).toEqual({ ok: true });
    expect(operatorVerdict('request_changes', pr({ stage: 'needs_human', pr_open: false }))).toMatchObject({ ok: false, reason: 'stage' });
  });

  it.each(['triaged', 'discussing', 'spec_ready', 'in_progress', 'merged', 'closed_unmerged', 'closed'])('is never offered at %s', (stage) => {
    expect(operatorVerdict('request_changes', pr({ stage }))).toMatchObject({ ok: false, reason: 'stage' });
  });

  it('fails closed when the open pull request or the round count is unknown', () => {
    expect(operatorVerdict('request_changes', at({ stage: 'review_passed' }))).toMatchObject({ ok: false });
    expect(operatorVerdict('request_changes', pr({ fix_rounds_started: undefined }))).toMatchObject({ ok: false, reason: 'rounds' });
  });

  it('respects the fix-round limit: the last round is allowed, one past it is not', () => {
    expect(operatorVerdict('request_changes', pr({ fix_rounds_started: max - 1 }))).toEqual({ ok: true });
    expect(operatorVerdict('request_changes', pr({ fix_rounds_started: max }))).toMatchObject({ ok: false, reason: 'rounds' });
  });

  it('owner or admin only, internal only, with a repository, an issue and a Spec, and no live run', () => {
    expect(operatorVerdict('request_changes', pr({ role: 'owner' }))).toEqual({ ok: true });
    expect(operatorVerdict('request_changes', pr({ role: 'member' }))).toMatchObject({ ok: false, reason: 'role' });
    expect(operatorVerdict('request_changes', pr({ provenance: 'external' }))).toMatchObject({ ok: false, reason: 'external' });
    expect(operatorVerdict('request_changes', pr({ repo_id: null }))).toMatchObject({ ok: false, reason: 'no_repo' });
    expect(operatorVerdict('request_changes', pr({ gh_number: null }))).toMatchObject({ ok: false, reason: 'no_issue' });
    expect(operatorVerdict('request_changes', pr({ has_spec: false }))).toMatchObject({ ok: false, reason: 'state' });
    expect(operatorVerdict('request_changes', pr({ live_run: true }))).toMatchObject({ ok: false, reason: 'live' });
  });
});
