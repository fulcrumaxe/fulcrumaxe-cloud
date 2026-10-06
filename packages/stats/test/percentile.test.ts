import { describe, expect, it } from 'vitest';
import { percentileCont, round } from '../src/percentile.js';

describe('percentileCont (D#45 S2 criterion 7)', () => {
  it('[1,2,3,4] gives p50 2.5 and p90 3.7', () => {
    expect(percentileCont([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentileCont([1, 2, 3, 4], 0.9)).toBeCloseTo(3.7, 10);
  });

  it('a single value gives that value for any p', () => {
    expect(percentileCont([5], 0.5)).toBe(5);
    expect(percentileCont([5], 0.9)).toBe(5);
    expect(percentileCont([5], 0)).toBe(5);
  });

  it('an empty array gives null', () => {
    expect(percentileCont([], 0.5)).toBeNull();
  });

  it('unsorted input gives the same result as sorted', () => {
    expect(percentileCont([4, 1, 3, 2], 0.5)).toBe(percentileCont([1, 2, 3, 4], 0.5));
    expect(percentileCont([4, 1, 3, 2], 0.9)).toBeCloseTo(percentileCont([1, 2, 3, 4], 0.9)!, 10);
  });
});

describe('round', () => {
  it('rounds to the given number of decimals', () => {
    expect(round(2.345, 2)).toBe(2.35);
    expect(round(2.344, 2)).toBe(2.34);
    expect(round(100, 4)).toBe(100);
    expect(round(1.23456, 0)).toBe(1);
  });
});
