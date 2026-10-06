import { describe, expect, it } from 'vitest';
import { checkFixRound, defaultFeatureCapUsd, defaultPerSpawnCapUsd, defaultSmallCapUsd, maxFixRounds } from '../src/caps.js';

// The plan data under test is the public scaled fixture (FX_PLAN_DATA, set by the test setup): invented figures.
describe('caps: read from the plan data', () => {
  it('returns the fixture caps', () => {
    expect(defaultPerSpawnCapUsd()).toBe(44);
    expect(defaultFeatureCapUsd()).toBe(270);
    expect(defaultSmallCapUsd()).toBe(66);
    expect(maxFixRounds()).toBe(4);
  });
});

describe('caps: fix-round escalation (H05 pass/fail 4)', () => {
  it('allows every round up to the limit', () => {
    expect(checkFixRound(1)).toBe('allow');
    expect(checkFixRound(maxFixRounds())).toBe('allow');
  });

  it('refuses the round after the limit with escalate', () => {
    expect(checkFixRound(maxFixRounds() + 1)).toBe('escalate');
    expect(checkFixRound(5)).toBe('escalate');
  });
});
