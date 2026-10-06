import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { compareQueueOrder } from '../src/work-items/queueOrder.js';
import {
  PriorityInputError,
  QueueRankRangeError,
  setWorkItemPriority,
  toQueueRank,
} from '../src/work-items/priority.js';

/** D#2 H26b: the parts of setWorkItemPriority that need no database. */
describe('toQueueRank (bigint arrives as a string)', () => {
  it('converts to a number, so 9 sorts before 10 (a string compare would put "10" first)', () => {
    const t = new Date(0);
    const nine = { id: 'a', priority: 2, queueRank: toQueueRank('9'), createdAt: t };
    const ten = { id: 'b', priority: 2, queueRank: toQueueRank('10'), createdAt: t };
    expect(typeof nine.queueRank).toBe('number');
    expect(compareQueueOrder(nine, ten)).toBeLessThan(0);
    expect('10' < '9').toBe(true); // the trap this conversion avoids
  });

  it('passes NULL through and accepts the safe-integer limit', () => {
    expect(toQueueRank(null)).toBeNull();
    expect(toQueueRank(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('fails loudly above the safe-integer limit, never rounding', () => {
    expect(() => toQueueRank(String(Number.MAX_SAFE_INTEGER + 1))).toThrow(QueueRankRangeError);
    expect(() => toQueueRank('9223372036854775807')).toThrow(QueueRankRangeError);
    expect(() => toQueueRank('-9007199254740993')).toThrow(QueueRankRangeError);
  });
});

describe('setWorkItemPriority input checks (before any query)', () => {
  const noPool = new Proxy({}, { get: () => () => { throw new Error('unexpected query'); } }) as unknown as Pool;
  const ctx = { pool: noPool, principal: { accountId: crypto.randomUUID(), userId: crypto.randomUUID() } };
  const id = crypto.randomUUID();

  it.each([
    [{ workItemId: id }],
    [{ workItemId: id, priority: 4 }],
    [{ workItemId: id, priority: -1 }],
    [{ workItemId: id, priority: 1.5 }],
    [{ workItemId: id, move: 'sideways' as never }],
    [{ workItemId: id, move: { before: 'not-a-uuid' } }],
  ])('%j is a PriorityInputError', async (input) => {
    await expect(setWorkItemPriority(ctx, input)).rejects.toBeInstanceOf(PriorityInputError);
  });
});
