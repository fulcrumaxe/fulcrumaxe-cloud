import { afterEach, describe, expect, it, vi } from 'vitest';
import { RECEIPT_HOOK_DEADLINE_CODE, RECEIPT_HOOK_DEADLINE_MS, runAfterReceipt, runAfterReceipts } from '../src/decisions/receiptHook.js';

/** D#7 DP6a-WIRING: the receipt block write never delays a decision beyond one short, fixed deadline. */
const A = '11111111-1111-4111-8111-111111111111';
const W = '22222222-2222-4222-8222-222222222222';
const never = (): Promise<void> => new Promise<void>(() => undefined);

afterEach(() => { vi.useRealTimers(); });

describe('runAfterReceipt', () => {
  it('returns at the deadline when the hook never resolves, logging only the fixed code', async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    let done = false;
    const p = runAfterReceipt(never, A, W, { warn }).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(RECEIPT_HOOK_DEADLINE_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(done).toBe(true);
    expect(warn.mock.calls).toEqual([[RECEIPT_HOOK_DEADLINE_CODE]]);
  });

  it('returns at once for a fast hook, swallows a throw and a rejection, and leaves no timer behind', async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    await runAfterReceipt(async () => undefined, A, W, { warn });
    await runAfterReceipt(() => { throw new Error('sync'); }, A, W, { warn });
    await runAfterReceipt(async () => { throw new Error('async'); }, A, W, { warn });
    expect(vi.getTimerCount()).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does nothing without a hook or a work item', async () => {
    const hook = vi.fn(async () => undefined);
    await runAfterReceipt(undefined, A, W);
    await runAfterReceipt(hook, A, null);
    expect(hook).not.toHaveBeenCalled();
  });
});

describe('runAfterReceipts', () => {
  it('puts the whole batch under one deadline: many hanging items cost one deadline, and no lane starts an item after it', async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const hook = vi.fn(never);
    const items = Array.from({ length: 30 }, (_, i) => ({ accountId: A, workItemId: `w${i}` }));
    let done = false;
    const p = runAfterReceipts(hook, items, { warn }).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(RECEIPT_HOOK_DEADLINE_MS);
    await p;
    expect(done).toBe(true);
    expect(warn.mock.calls).toEqual([[RECEIPT_HOOK_DEADLINE_CODE]]);
    expect(hook.mock.calls.length).toBeLessThan(items.length);
  });

  it('refreshes each distinct item once and survives hooks that throw', async () => {
    const seen: string[] = [];
    await runAfterReceipts(async ({ workItemId }) => { seen.push(workItemId); if (workItemId === 'a') throw new Error('x'); }, [
      { accountId: A, workItemId: 'a' }, { accountId: A, workItemId: 'a' }, { accountId: A, workItemId: 'b' }, { accountId: A, workItemId: null },
    ]);
    expect(seen.sort()).toEqual(['a', 'b']);
  });
});
