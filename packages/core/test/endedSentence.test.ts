import { describe, expect, it } from 'vitest';
import { endedSentence } from '../src/work-items/activity.js';

describe('the default reason a build ended', () => {
  it('says "without a pull request" only when the item has none', () => {
    expect(endedSentence('timed_out', null)).toBe('The executor run timed out without a pull request.');
    expect(endedSentence('failed', 813)).toBe('The executor run failed before the item could move on.');
    expect(endedSentence('failed', 813)).not.toMatch(/without a pull request/);
  });
});
