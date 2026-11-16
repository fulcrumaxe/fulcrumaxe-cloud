import { describe, expect, it } from 'vitest';
import { PUBLIC_CHANGE_REFUSAL_REASON, republishFailedReason } from '../src/repos/publicChangeCopy.js';
import { loadPlanData } from '@fx/plan-data';
import { REPUBLISH_FAILED_PRESS_SENTENCE, REPUBLISH_FAILED_ROUNDS_SENTENCE, REPUBLISH_FAILED_SENTENCE, republishFailedSentence } from '../src/work-items/baseSync.js';
import { operatorVerdict, type OperatorFacts } from '../src/work-items/operatorActions.js';

// A paired item whose public update failed: Needs a person, reached from a pull-request stage, so the pull request is still open and Build again's rebuild would stop at it.
const facts = (over: Partial<OperatorFacts> = {}): OperatorFacts =>
  ({ stage: 'needs_human', provenance: 'internal', repo_id: 'r', gh_number: 7, discussion_id: 'd', kind: 'feature', has_spec: true, live_run: false, role: 'owner', spec_file_list_known: true, pr_open: true, fix_rounds_started: 1, ...over }) as OperatorFacts;
const sentenceFor = (f: OperatorFacts) => {
  const v = operatorVerdict('request_changes', f);
  return republishFailedSentence(v.ok, !v.ok && v.reason === 'rounds');
};

describe('the republish_failed sentence names the step the card lists', () => {
  it('Request changes offered: the sentence tells the viewer to press it', () => {
    expect(operatorVerdict('request_changes', facts())).toEqual({ ok: true });
    expect(sentenceFor(facts())).toBe(REPUBLISH_FAILED_PRESS_SENTENCE);
  });
  it('every fix round used: the sentence says the cloud cannot run another and names no button', () => {
    expect(sentenceFor(facts({ fix_rounds_started: loadPlanData().caps.maxFixRounds }))).toBe(REPUBLISH_FAILED_ROUNDS_SENTENCE);
  });
  it('a viewer who cannot press it, or agents still working: the sentence true for anyone', () => {
    expect(sentenceFor(facts({ role: 'member' }))).toBe(REPUBLISH_FAILED_SENTENCE);
    expect(sentenceFor(facts({ live_run: true }))).toBe(REPUBLISH_FAILED_SENTENCE);
  });
  it('none sends the person to Build again, and none is empty or shows a code', () => {
    for (const s of [REPUBLISH_FAILED_PRESS_SENTENCE, REPUBLISH_FAILED_ROUNDS_SENTENCE, REPUBLISH_FAILED_SENTENCE]) {
      expect(s).not.toMatch(/Build again|null|undefined|republish_/);
      expect(s.length).toBeGreaterThan(40);
    }
  });

  it('a stored refusal reason is spliced in after the lead, in every variant, and the step stays the same', () => {
    const reason = PUBLIC_CHANGE_REFUSAL_REASON.base_diverged!;
    for (const [press, rounds, generic] of [[true, false, REPUBLISH_FAILED_PRESS_SENTENCE], [false, true, REPUBLISH_FAILED_ROUNDS_SENTENCE], [false, false, REPUBLISH_FAILED_SENTENCE]] as const) {
      const s = republishFailedSentence(press, rounds, reason);
      expect(s).toContain(`Refused: ${reason}. `);
      expect(s.replace(`Refused: ${reason}. `, '')).toBe(generic);
      expect(s).not.toMatch(/Build again|null|undefined|base_diverged/);
      expect(republishFailedSentence(press, rounds, null)).toBe(generic);
    }
  });

  it('a terminal reason ends the sentence on the reason, with no step and never both contradicting halves', () => {
    for (const code of ['base_unavailable', 'base_not_on_parent', 'merge_in_change', 'base_not_on_default']) {
      const r = republishFailedReason(code)!;
      expect(r.terminal).toBe(true);
      for (const [press, rounds] of [[true, false], [false, true], [false, false]] as const) {
        const s = republishFailedSentence(press, rounds, r.text, r.terminal);
        expect(s).toContain('retrying will not help');
        expect(s).not.toMatch(/Request changes|run another round/);
      }
    }
  });
  it('a retryable reason is not terminal; private_path_change, stack_base_unavailable and unknown codes have no reason', () => {
    expect(republishFailedReason('base_diverged')).toEqual({ text: PUBLIC_CHANGE_REFUSAL_REASON.base_diverged, terminal: false });
    for (const code of ['private_path_change', 'stack_base_unavailable', 'nope', null, undefined]) expect(republishFailedReason(code)).toBeNull();
    // Every stored reason that says retrying will not help is on the terminal list.
    for (const [code, text] of Object.entries(PUBLIC_CHANGE_REFUSAL_REASON)) if (/retrying will not help/.test(text)) expect(republishFailedReason(code)?.terminal, code).toBe(true);
  });
});
