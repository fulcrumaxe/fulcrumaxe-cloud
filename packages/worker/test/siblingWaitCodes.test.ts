import { describe, expect, it } from 'vitest';
import { AFTER_PR_REASON_PREFIX, SIBLING_MERGED_WAIT_CODE } from '@fx/core/src/work-items/mergeReadiness.js';
import { SIBLING_WAKE_CODE, afterPrReason } from '../src/siblingConflictWake.js';

// @fx/core cannot import the worker, so the activity read keeps its own copy of the wake's code and reason shape. This holds the two equal: if the wake changes
// what it records, the card's "conflicts with main after #N merged" line would silently stop appearing.
describe('the sibling wake fact and the activity read agree', () => {
  it('the code is the same', () => {
    expect(SIBLING_MERGED_WAIT_CODE).toBe(SIBLING_WAKE_CODE);
  });

  it("the merged number reason is the read's prefix followed by the number", () => {
    expect(afterPrReason(41)).toBe(`${AFTER_PR_REASON_PREFIX}41`);
    expect(afterPrReason(123456)).toBe(`${AFTER_PR_REASON_PREFIX}123456`);
  });
});
