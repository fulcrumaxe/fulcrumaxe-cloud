import { describe, expect, it } from 'vitest';
import { reviewerUnverifiableSentence } from '../src/work-items/activity.js';

describe('reviewerUnverifiableSentence', () => {
  it('one criterion: names the reviewer, the criterion and why, and says nothing was sent back to the builder', () => {
    const s = reviewerUnverifiableSentence(['acceptance_tester'], [{ criterion: 'AC4', reason: 'the test is skipped here' }]);
    expect(s).toBe('The acceptance tester could not verify this criterion where it ran, so no changes were requested and nothing was sent back to the builder. A person needs to verify it, then merge or close the pull request on GitHub:\n1. AC4 (could not verify because: the test is skipped here)');
  });

  it('several criteria: numbered, in order; a criterion with no reason has no "because"', () => {
    const s = reviewerUnverifiableSentence(['acceptance_tester'], [{ criterion: 'A', reason: 'r1' }, { criterion: 'B', reason: '' }])!;
    expect(s).toContain('these criteria');
    expect(s.split('\n').slice(1)).toEqual(['1. A (could not verify because: r1)', '2. B']);
  });

  it('is bounded: ten long items stay within the cap', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ criterion: `c${i}${'x'.repeat(500)}`, reason: 'y'.repeat(500) }));
    expect(reviewerUnverifiableSentence(['acceptance_tester'], items)!.length).toBeLessThanOrEqual(3500);
  });

  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])('a reviewer code that is the object property "%s" is not a reviewer: null', (key) => {
    expect(reviewerUnverifiableSentence([key], [{ criterion: 'A', reason: 'r' }])).toBeNull();
  });

  it.each([undefined, null, [], 'AC4', [{ reason: 'x' }], [{ criterion: 3 }], {}])('a stored value with no usable item (%j) is null', (stored) => {
    expect(reviewerUnverifiableSentence(['acceptance_tester'], stored)).toBeNull();
  });

  it('no reasons: null', () => {
    expect(reviewerUnverifiableSentence([], [{ criterion: 'A', reason: 'r' }])).toBeNull();
  });
});
