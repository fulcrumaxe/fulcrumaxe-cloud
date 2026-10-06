import { describe, expect, it } from 'vitest';
import { compareQueueOrder, type QueueOrderKey } from '../src/work-items/queueOrder.js';

const t = (s: number) => new Date(1_700_000_000_000 + s * 1000);
const k = (id: string, priority: number, queueRank: number | null, created: number): QueueOrderKey => ({
  id,
  priority,
  queueRank,
  createdAt: t(created),
});

describe('compareQueueOrder (D#2 H26a)', () => {
  it('orders by priority first, ahead of rank and age', () => {
    expect(compareQueueOrder(k('a', 0, 999, 50), k('b', 1, 1, 1))).toBeLessThan(0);
    expect(compareQueueOrder(k('a', 3, 1, 1), k('b', 2, 999, 50))).toBeGreaterThan(0);
  });

  it('within a priority, a smaller rank comes first', () => {
    expect(compareQueueOrder(k('a', 2, 1024, 50), k('b', 2, 2048, 1))).toBeLessThan(0);
  });

  it('within a priority, any rank comes before a NULL rank', () => {
    expect(compareQueueOrder(k('a', 2, 5_000_000, 50), k('b', 2, null, 1))).toBeLessThan(0);
    expect(compareQueueOrder(k('a', 2, null, 1), k('b', 2, 0, 50))).toBeGreaterThan(0);
  });

  it('two NULL ranks fall through to created_at, older first', () => {
    expect(compareQueueOrder(k('a', 2, null, 1), k('b', 2, null, 2))).toBeLessThan(0);
    expect(compareQueueOrder(k('a', 2, null, 2), k('b', 2, null, 1))).toBeGreaterThan(0);
  });

  it('equal rank falls through to created_at, older first', () => {
    expect(compareQueueOrder(k('a', 2, 1024, 9), k('b', 2, 1024, 3))).toBeGreaterThan(0);
  });

  it('equal everything else falls through to id', () => {
    expect(compareQueueOrder(k('a', 2, 1024, 1), k('b', 2, 1024, 1))).toBeLessThan(0);
    expect(compareQueueOrder(k('b', 2, 1024, 1), k('a', 2, 1024, 1))).toBeGreaterThan(0);
  });

  it('is 0 only for the same item', () => {
    expect(compareQueueOrder(k('a', 2, null, 1), k('a', 2, null, 1))).toBe(0);
  });

  it('compares bigint ranks exactly, beyond 2^53', () => {
    const a = { ...k('a', 2, null, 1), queueRank: 9_007_199_254_740_993n };
    const b = { ...k('b', 2, null, 1), queueRank: 9_007_199_254_740_992n };
    expect(compareQueueOrder(a, b)).toBeGreaterThan(0);
  });

  it('is a strict total order over a mixed set: antisymmetric, transitive, and every shuffle sorts the same', () => {
    const items = [
      k('i1', 0, null, 5),
      k('i2', 0, 2048, 9),
      k('i3', 0, 1024, 9),
      k('i4', 1, null, 1),
      k('i5', 2, null, 1),
      k('i6', 2, null, 1),
      k('i7', 2, 1024, 8),
      k('i8', 2, 1024, 7),
      k('i9', 3, 1, 1),
    ];
    const expected = ['i3', 'i2', 'i1', 'i4', 'i8', 'i7', 'i5', 'i6', 'i9'];
    for (const x of items) {
      for (const y of items) {
        expect(Math.sign(compareQueueOrder(x, y)) + Math.sign(compareQueueOrder(y, x))).toBe(0);
        if (x !== y) expect(compareQueueOrder(x, y)).not.toBe(0);
        for (const z of items) {
          if (compareQueueOrder(x, y) < 0 && compareQueueOrder(y, z) < 0) {
            expect(compareQueueOrder(x, z)).toBeLessThan(0);
          }
        }
      }
    }
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let n = 0; n < 200; n++) {
      const shuffled = [...items].sort(() => rnd() - 0.5);
      expect(shuffled.sort(compareQueueOrder).map((i) => i.id)).toEqual(expected);
    }
  });
});
