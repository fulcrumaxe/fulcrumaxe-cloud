import { describe, expect, it } from 'vitest';
import { WORK_ITEM_STAGES } from '../src/work-items/stages.js';
import { ADVANCEABLE_STAGES, ADVANCE_LIGHT_KINDS, ADVANCE_NON_BUILDABLE_KINDS, ADVANCE_PANEL_KINDS, advanceActionFor } from '../src/work-items/advance.js';

/** D#483: the one table of what the stage driver can advance, and what advancing does. */
describe('advanceActionFor', () => {
  const TRIAGED = { stage: 'triaged', discussion_id: null, kind: null, has_spec: false };
  const SPEC = { stage: 'spec_ready', discussion_id: 'd', kind: 'feature', has_spec: true };

  it('triaged with no discussion is triaged by the driver; with one it is already triaged', () => {
    expect(advanceActionFor(TRIAGED)).toEqual({ ok: true, action: 'triage' });
    expect(advanceActionFor({ ...TRIAGED, discussion_id: 'd' })).toEqual({ ok: false, reason: 'state', message: 'work item is already triaged' });
  });

  it.each(['critical', 'feature', 'small', 'bug', 'doc'])('spec_ready with a published %s Spec is built', (kind) => {
    expect(advanceActionFor({ ...SPEC, kind })).toEqual({ ok: true, action: 'build' });
  });

  it.each([
    ['no discussion', { discussion_id: null }],
    ['no Spec', { has_spec: false }],
    ['no kind', { kind: null }],
    ['a project', { kind: 'project' }],
    ['a question', { kind: 'question' }],
  ])('spec_ready with %s is refused for its state, with a message and no stage claim', (_n, over) => {
    const v = advanceActionFor({ ...SPEC, ...over });
    expect(v).toMatchObject({ ok: false, reason: 'state' });
    expect((v as { message: string }).message).not.toMatch(/undefined|null/);
  });

  it.each(['small', 'bug', 'doc'])('a triaged %s item the pipeline already discussed, with no Spec, gets its short Spec again (light_spec)', (kind) => {
    expect(advanceActionFor({ stage: 'triaged', discussion_id: 'd', kind, has_spec: false })).toEqual({ ok: true, action: 'light_spec' });
  });

  it('a triaged item with no discussion is still triaged first, whatever its kind', () => {
    expect(advanceActionFor({ stage: 'triaged', discussion_id: null, kind: 'bug', has_spec: false })).toEqual({ ok: true, action: 'triage' });
  });

  it.each([
    ['a bug that already has its Spec', { kind: 'bug', has_spec: true }],
    ['a question', { kind: 'question', has_spec: false }],
    ['a feature (it has a panel; triage moves it to discussing)', { kind: 'feature', has_spec: false }],
    ['an item with no kind', { kind: null, has_spec: false }],
  ])('a triaged item the pipeline already discussed: %s is already triaged', (_n, over) => {
    expect(advanceActionFor({ stage: 'triaged', discussion_id: 'd', ...over })).toEqual({ ok: false, reason: 'state', message: 'work item is already triaged' });
  });

  it('the light kinds and the panel kinds are disjoint and are the kinds triage sends each way', () => {
    expect([...ADVANCE_LIGHT_KINDS]).toEqual(['small', 'bug', 'doc']);
    for (const k of ADVANCE_LIGHT_KINDS) expect((ADVANCE_PANEL_KINDS as readonly string[]).includes(k)).toBe(false);
  });

  it.each([
    ['feature', true],
    ['critical', true],
    ['project', false],
    ['question', false],
    ['bug', false],
    [null, false],
  ])('discussing with a %s discussion and no Spec runs the panel and Spec again: %s', (kind, ok) => {
    const v = advanceActionFor({ stage: 'discussing', discussion_id: 'd', kind, has_spec: false });
    expect(v.ok).toBe(ok);
    if (ok) expect(v).toEqual({ ok: true, action: 'spec' });
    else expect((v as { message: string }).message).not.toMatch(/undefined|null/);
  });

  it('discussing with no discussion is refused for its state', () => {
    expect(advanceActionFor({ stage: 'discussing', discussion_id: null, kind: 'feature', has_spec: false })).toMatchObject({ ok: false, reason: 'state' });
  });

  it('discussing WITH a Spec already runs the panel and the Spec again (Back to discussion leaves an item here on purpose; a new version supersedes the old)', () => {
    expect(advanceActionFor({ stage: 'discussing', discussion_id: 'd', kind: 'feature', has_spec: true })).toEqual({ ok: true, action: 'spec' });
    expect(advanceActionFor({ stage: 'discussing', discussion_id: 'd', kind: 'project', has_spec: true })).toMatchObject({ ok: false, reason: 'state' });
  });

  it.each(['critical', 'feature', 'small', 'bug', 'doc'])('needs_human with a published %s Spec is built again (rebuild)', (kind) => {
    expect(advanceActionFor({ stage: 'needs_human', discussion_id: 'd', kind, has_spec: true })).toEqual({ ok: true, action: 'rebuild' });
  });

  it.each([
    ['no discussion', { discussion_id: null }],
    ['no Spec', { has_spec: false }],
    ['no kind', { kind: null }],
    ['a project', { kind: 'project' }],
    ['a question', { kind: 'question' }],
  ])('needs_human with %s has nothing to build again: refused for its state', (_n, over) => {
    const v = advanceActionFor({ stage: 'needs_human', discussion_id: 'd', kind: 'feature', has_spec: true, ...over });
    expect(v).toMatchObject({ ok: false, reason: 'state' });
    expect((v as { message: string }).message).not.toMatch(/undefined|null/);
  });

  it.each(['pr_opened', 'changes_requested', 'review_passed'])('%s with a Spec is reviewed; without one it is refused for its state', (stage) => {
    expect(advanceActionFor({ stage, discussion_id: 'd', kind: 'feature', has_spec: true })).toEqual({ ok: true, action: 'review' });
    expect(advanceActionFor({ stage, discussion_id: null, kind: null, has_spec: false })).toMatchObject({ ok: false, reason: 'state' });
  });

  it('in_progress with a Spec is checked (the build\'s pull request is looked for); without one it is refused for its state', () => {
    expect(advanceActionFor({ stage: 'in_progress', discussion_id: 'd', kind: 'feature', has_spec: true })).toEqual({ ok: true, action: 'check_build' });
    expect(advanceActionFor({ stage: 'in_progress', discussion_id: null, kind: null, has_spec: false })).toMatchObject({ ok: false, reason: 'state' });
  });

  it.each(['merged', 'closed_unmerged', 'closed'])('%s is never advanced', (stage) => {
    expect(advanceActionFor({ stage, discussion_id: 'd', kind: 'feature', has_spec: true })).toMatchObject({ ok: false, reason: 'stage' });
  });

  it('every other stage is refused for its stage, including names that are not stages at all', () => {
    for (const stage of [...WORK_ITEM_STAGES.filter((s) => !ADVANCEABLE_STAGES.includes(s)), '__proto__', 'constructor', 'toString', '']) {
      expect(advanceActionFor({ ...SPEC, stage }), stage).toEqual({ ok: false, reason: 'stage', message: `work item is ${stage}` });
    }
  });

  it('the advanceable stages are real stages, in pipeline order, and the list is frozen', () => {
    expect([...ADVANCEABLE_STAGES]).toEqual(['triaged', 'discussing', 'spec_ready', 'in_progress', 'pr_opened', 'changes_requested', 'review_passed', 'needs_human']);
    expect([...ADVANCE_PANEL_KINDS]).toEqual(['critical', 'feature']);
    for (const s of ADVANCEABLE_STAGES) expect(WORK_ITEM_STAGES as readonly string[]).toContain(s);
    expect(Object.isFrozen(ADVANCEABLE_STAGES)).toBe(true);
    expect([...ADVANCE_NON_BUILDABLE_KINDS]).toEqual(['question', 'project']);
  });
});
