import { describe, expect, it } from 'vitest';
import { loadPlanData } from '@fx/plan-data';
import { BASE_SYNC_CONFLICT_SENTENCE, BASE_SYNC_UNAVAILABLE_SENTENCE, FIX_ROUND_STOP_SENTENCE, REPUBLISH_NO_CHANGE_SENTENCE, REPUBLISH_TIP_MOVED_SENTENCE, openPrStopSentence } from '../src/work-items/baseSync.js';
import { operatorVerdict, type OperatorFacts } from '../src/work-items/operatorActions.js';

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
