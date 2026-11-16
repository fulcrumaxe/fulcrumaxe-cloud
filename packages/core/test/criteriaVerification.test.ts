import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { criteriaItemsFromEnvelope, matchesUnverifiableStop, type UnverifiableStop } from '../src/work-items/criteriaVerification.js';

describe('criteriaItemsFromEnvelope', () => {
  it('numbers the items by their position in the stored list', () => {
    const items = criteriaItemsFromEnvelope([{ criterion: 'AC1', reason: 'r1' }, { criterion: 'AC2', reason: 'r2' }]);
    expect(items).toEqual([{ index: 0, criterion: 'AC1', reason: 'r1' }, { index: 1, criterion: 'AC2', reason: 'r2' }]);
  });

  it('is bounded at 10 items, each criterion and reason cut to 400 characters (readUnverifiable\'s own bounds)', () => {
    const long = Array.from({ length: 15 }, (_, i) => ({ criterion: `c${i}${'x'.repeat(500)}`, reason: 'y'.repeat(500) }));
    const items = criteriaItemsFromEnvelope(long);
    expect(items).toHaveLength(10);
    expect(items[0]!.index).toBe(0);
    expect(items[9]!.index).toBe(9);
    for (const item of items) {
      expect(item.criterion.length).toBeLessThanOrEqual(400);
      expect(item.reason.length).toBeLessThanOrEqual(400);
    }
  });

  it.each([undefined, null, [], 'AC4', [{ reason: 'x' }], [{ criterion: 3 }], {}])('a stored value with no usable item (%j) gives none', (raw) => {
    expect(criteriaItemsFromEnvelope(raw)).toEqual([]);
  });

  it('a malformed entry among good ones is skipped, without shifting the index of the ones kept', () => {
    const items = criteriaItemsFromEnvelope([{ criterion: 'AC1', reason: 'r1' }, { criterion: 3 }, { criterion: 'AC3', reason: 'r3' }]);
    // readUnverifiable drops the malformed entry before this module ever numbers what is left: the kept items are 0 and 1, not 0 and 2.
    expect(items).toEqual([{ index: 0, criterion: 'AC1', reason: 'r1' }, { index: 1, criterion: 'AC3', reason: 'r3' }]);
  });
});

describe('matchesUnverifiableStop', () => {
  const runA = randomUUID();
  const runB = randomUUID();
  const stop: Pick<UnverifiableStop, 'roles'> = {
    roles: [
      { role: 'acceptance-tester', runId: runA, items: [{ index: 0, criterion: 'AC1', reason: 'r' }, { index: 1, criterion: 'AC2', reason: 'r' }] },
      { role: 'code-reviewer', runId: runB, items: [{ index: 0, criterion: 'AC3', reason: 'r' }] },
    ],
  };

  it('the exact derived set, across every role, matches', () => {
    expect(matchesUnverifiableStop(stop, [{ runId: runA, index: 0 }, { runId: runA, index: 1 }, { runId: runB, index: 0 }])).toBe(true);
  });

  it('order does not matter', () => {
    expect(matchesUnverifiableStop(stop, [{ runId: runB, index: 0 }, { runId: runA, index: 1 }, { runId: runA, index: 0 }])).toBe(true);
  });

  it('omitting one pair fails', () => {
    expect(matchesUnverifiableStop(stop, [{ runId: runA, index: 0 }, { runId: runB, index: 0 }])).toBe(false);
  });

  it('a pair outside the derived list fails, even alongside every real pair', () => {
    expect(matchesUnverifiableStop(stop, [{ runId: runA, index: 0 }, { runId: runA, index: 1 }, { runId: runB, index: 0 }, { runId: runB, index: 1 }])).toBe(false);
  });

  it('a pair naming the wrong run fails', () => {
    expect(matchesUnverifiableStop(stop, [{ runId: runA, index: 0 }, { runId: runA, index: 1 }, { runId: randomUUID(), index: 0 }])).toBe(false);
  });

  it('repeating a real pair instead of sending the other one fails (the count matches by accident, the set does not)', () => {
    expect(matchesUnverifiableStop(stop, [{ runId: runA, index: 0 }, { runId: runA, index: 0 }, { runId: runB, index: 0 }])).toBe(false);
  });

  it('an empty stop is matched only by an empty confirm list', () => {
    expect(matchesUnverifiableStop({ roles: [] }, [])).toBe(true);
    expect(matchesUnverifiableStop({ roles: [] }, [{ runId: runA, index: 0 }])).toBe(false);
  });

  it('criterion text sent alongside a pair is not part of the check: only the (runId, index) pair is read', () => {
    const withText = [{ runId: runA, index: 0, criterion: 'something else entirely' }, { runId: runA, index: 1, criterion: 'also fake' }, { runId: runB, index: 0, criterion: 'fake too' }] as unknown as Array<{ runId: string; index: number }>;
    expect(matchesUnverifiableStop(stop, withText)).toBe(true);
  });
});
