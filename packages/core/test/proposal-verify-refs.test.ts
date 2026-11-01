import { describe, expect, it } from 'vitest';
import { proposalVerifyKey, verifySourceRefs, type VerifyKeyInput } from '../src/plan/proposalVerifyLimits.js';

/**
 * D#483 S4-f2 (C25-f2-6): the analyst's refs join the verifier's source lines and its run key, and a row without them keeps the key it had
 * before they existed. The literals below were computed with the key function as it stood before the change (sha256 of the JSON of
 * [title, summary, refs], first 8 hex), so this test fails if the old shape moves.
 */
const old: VerifyKeyInput = { id: '11111111-1111-4111-8111-111111111111', title: 'Add dark mode', summary: 'Some summary', gh_number: 12, discussion_number: 7, verify_attempts: 2, analysis_refs: null };

describe('verifySourceRefs and proposalVerifyKey with analysis refs', () => {
  it('are byte-identical for a row with no analysis_refs (null or empty)', () => {
    for (const row of [old, { ...old, analysis_refs: [] }]) {
      expect(verifySourceRefs(row)).toEqual(['#12', '#7']);
      expect(proposalVerifyKey(row)).toBe('proposal-verify:11111111-1111-4111-8111-111111111111:17ad5799:2');
    }
    expect(proposalVerifyKey({ id: 'x', title: 'T', summary: null, gh_number: null, discussion_number: null, verify_attempts: 0, analysis_refs: null })).toBe('proposal-verify:x:72504fea:0');
  });

  it('include the refs, after the item numbers, and a different key', () => {
    const row = { ...old, discussion_number: null, analysis_refs: ['docs/a.md:3-9'] };
    expect(verifySourceRefs(row)).toEqual(['#12', 'docs/a.md:3-9']);
    expect(proposalVerifyKey(row)).toBe('proposal-verify:11111111-1111-4111-8111-111111111111:0ec6b600:2');
    expect(proposalVerifyKey({ ...row, analysis_refs: ['docs/a.md:3-10'] })).not.toBe(proposalVerifyKey(row));
    expect(verifySourceRefs({ gh_number: null, discussion_number: null, analysis_refs: ['a.ts:1-2', 'b.ts:3-4'] })).toEqual(['a.ts:1-2', 'b.ts:3-4']);
  });
});
