import { describe, expect, it } from 'vitest';
import { loadPlanData } from '@fx/plan-data';
import { BASE_SYNC_CONFLICT_SENTENCE, BASE_SYNC_UNAVAILABLE_SENTENCE, FIX_ROUND_STOP_SENTENCE, REPUBLISH_NO_CHANGE_SENTENCE, REPUBLISH_STACKED_UNSUPPORTED_SENTENCE, REPUBLISH_STACK_PARENT_CLOSED_SENTENCE, REPUBLISH_STACK_PARENT_ENDED_SENTENCE, REPUBLISH_STACK_PARENT_NO_PULL_REQUEST_SENTENCE, REPUBLISH_STACK_PARENT_OFF_MAIN_SENTENCE, REPUBLISH_STACK_PARENT_OPEN_SENTENCE, REPUBLISH_TIP_MOVED_SENTENCE, openPrStopSentence } from '../src/work-items/baseSync.js';
import { operatorActionsFor, operatorVerdict, type OperatorFacts } from '../src/work-items/operatorActions.js';

// A fix round only runs while the pull request is open, so Build again's rebuild would stop at it: these stops must name Request changes, as the card lists it for the viewer.
const facts = (over: Partial<OperatorFacts> = {}): OperatorFacts =>
  ({ stage: 'needs_human', provenance: 'internal', repo_id: 'r', gh_number: 7, discussion_id: 'd', kind: 'feature', has_spec: true, live_run: false, role: 'owner', spec_file_list_known: true, pr_open: true, fix_rounds_started: 1, ...over }) as OperatorFacts;
const sentenceFor = (generic: string, f: OperatorFacts) => {
  const v = operatorVerdict('request_changes', f);
  return openPrStopSentence(generic, v.ok, !v.ok && v.reason === 'rounds');
};
const GENERIC = [BASE_SYNC_CONFLICT_SENTENCE, BASE_SYNC_UNAVAILABLE_SENTENCE, REPUBLISH_NO_CHANGE_SENTENCE, REPUBLISH_TIP_MOVED_SENTENCE];

describe('stops of a fix round on an open pull request name the step the viewer can take', () => {
  it.each(GENERIC)('Request changes offered: %s ends on pressing it', (generic) => {
    const s = sentenceFor(generic, facts());
    expect(s).toMatch(/ Press Request changes to run another round\.$/);
    expect(s.startsWith(generic.slice(0, generic.indexOf(' An owner')))).toBe(true);
  });
  it.each(GENERIC)('every fix round used: %s says the cloud cannot run another and names no button', (generic) => {
    const s = sentenceFor(generic, facts({ fix_rounds_started: loadPlanData().caps.maxFixRounds }));
    expect(s).toMatch(/All of this pull request's fix rounds are used, so the cloud can't run another\./);
    expect(s).not.toMatch(/Request changes/);
  });
  it.each(GENERIC)('a viewer who cannot press it, or agents still working: %s keeps the sentence true for anyone', (generic) => {
    expect(sentenceFor(generic, facts({ role: 'member' }))).toBe(generic);
    expect(sentenceFor(generic, facts({ live_run: true }))).toBe(generic);
  });
  it('none of them sends the person to Build again, and any other text passes through unchanged', () => {
    for (const s of GENERIC) expect(s).not.toMatch(/Build again/);
    expect(openPrStopSentence('Something else entirely.', true, false)).toBe('Something else entirely.');
  });
  it('the table still holds them under their codes', () => {
    expect(FIX_ROUND_STOP_SENTENCE['base_sync_conflict']).toBe(BASE_SYNC_CONFLICT_SENTENCE);
    expect(FIX_ROUND_STOP_SENTENCE['republish_tip_moved']).toBe(REPUBLISH_TIP_MOVED_SENTENCE);
  });
});

// Every stop sentence the table holds, crossed with who is looking: the step a sentence names must be one the viewer's card really lists (read from operatorActionsFor, not a copy of its rules).
const STACKED = [REPUBLISH_STACK_PARENT_ENDED_SENTENCE, REPUBLISH_STACK_PARENT_CLOSED_SENTENCE, REPUBLISH_STACK_PARENT_OPEN_SENTENCE, REPUBLISH_STACKED_UNSUPPORTED_SENTENCE];
const NO_STEP = [REPUBLISH_STACK_PARENT_OFF_MAIN_SENTENCE, REPUBLISH_STACK_PARENT_NO_PULL_REQUEST_SENTENCE];
const VIEWERS: Array<[string, Partial<OperatorFacts>]> = [
  ['owner, pull request open', {}],
  ['admin, pull request open', { role: 'admin' }],
  ['member', { role: 'member' }],
  ['owner, agents working', { live_run: true }],
  ['owner, all rounds used', { fix_rounds_started: loadPlanData().caps.maxFixRounds }],
  ['owner, no open pull request', { pr_open: false }],
];
describe('every stop sentence names only a step the viewer can take', () => {
  it.each([...GENERIC, ...STACKED])('%s', (generic) => {
    for (const [name, over] of VIEWERS) {
      const f = facts(over);
      const offered = operatorActionsFor(f).includes('request_changes');
      const s = sentenceFor(generic, f);
      if (offered) expect(s, name).toMatch(/press Request changes to run another round\./i);
      else if (!over.role || over.role === 'owner' || over.role === 'admin') {
        if (over.fix_rounds_started !== undefined) { expect(s, name).not.toMatch(/Request changes/); expect(s, name).toMatch(/fix rounds are used/); }
        else expect(s, name).toBe(generic);
      } else expect(s, name).toBe(generic);
      // a sentence that tells the viewer to press it must be one whose card lists it
      if (/\bpress Request changes to run another round/i.test(s) && !/owner or admin can press/i.test(s)) expect(offered, name).toBe(true);
    }
  });
  it.each(NO_STEP)('stops that name no Request changes step are never changed: %s', (sentence) => {
    for (const [, over] of VIEWERS) expect(sentenceFor(sentence, facts(over))).toBe(sentence);
  });
  it('stacked sentences keep their GitHub step and any later text', () => {
    const s = sentenceFor(REPUBLISH_STACKED_UNSUPPORTED_SENTENCE, facts({ fix_rounds_started: loadPlanData().caps.maxFixRounds }));
    expect(s).toMatch(/change this pull request's base to main on GitHub\. All of this pull request's fix rounds are used/);
    expect(s).toMatch(/If it was merged into a branch other than main/);
    expect(sentenceFor(REPUBLISH_STACK_PARENT_ENDED_SENTENCE, facts())).toMatch(/GitHub; then press Request changes to run another round\.$/);
  });
});
