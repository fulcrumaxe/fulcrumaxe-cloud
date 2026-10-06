import { describe, expect, it } from 'vitest';
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
const BASE: OperatorFacts = { stage: 'needs_human', discussion_id: 'd', kind: 'feature', has_spec: true, provenance: 'internal', repo_id: 'r', gh_number: '12', live_run: false, role: 'admin' };
const at = (over: Partial<OperatorFacts>): OperatorFacts => ({ ...BASE, ...over });

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
