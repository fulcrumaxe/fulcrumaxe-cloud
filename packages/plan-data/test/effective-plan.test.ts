import { describe, expect, it } from 'vitest';
import { effectivePlan } from '../src/index.js';

/** D#845 ON-22a (ruling 42): the one place a limit's plan is chosen. */
describe('effectivePlan', () => {
  it('is the row\'s plan only while the account carries a paid hosted plan item', () => {
    expect(effectivePlan({ plan: 'team', hosted_plan_paid: true }, 'runner')).toBe('team');
    expect(effectivePlan({ plan: 'team', hosted_plan_paid: false }, 'runner')).toBe('runner');
    expect(effectivePlan({ plan: 'scale', hosted_plan_paid: false }, 'starter')).toBe('starter');
  });

  it('a missing or odd fact reads as not paid (fail closed)', () => {
    for (const fact of [null, undefined, 0, 'true', 1] as unknown[]) {
      expect(effectivePlan({ plan: 'scale', hosted_plan_paid: fact as boolean }, 'runner')).toBe('runner');
    }
  });
});
