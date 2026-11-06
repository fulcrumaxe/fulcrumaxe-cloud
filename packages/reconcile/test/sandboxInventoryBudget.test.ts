import { describe, expect, it } from 'vitest';
import { INVENTORY_MAX_PAGES_PER_PREFIX } from '@fx/runner';
import { parseSandboxReapMode, sandboxInventoryJob, SANDBOX_INVENTORY_CALLS_PER_RUN, type JobContext, type SandboxReapWorker } from '../src/index.js';

/** The inventory job hands the worker what its call budget has left and charges what the worker spent. */
function ctxWith(limit: number, used: number): { ctx: JobContext; spent: () => number } {
  let spent = used;
  const ctx = {
    cursor: null,
    calls: {
      limit,
      get used() {
        return spent;
      },
      take(n = 1) {
        if (spent + n > limit) return false;
        spent += n;
        return true;
      },
    },
    msLeft: () => 60_000,
    checkpoint: () => undefined,
  } as unknown as JobContext;
  return { ctx, spent: () => spent };
}

describe('the inventory job and its call budget', () => {
  it('the allowance is one page cap for each of the three prefixes', () => {
    expect(SANDBOX_INVENTORY_CALLS_PER_RUN).toBe(3 * INVENTORY_MAX_PAGES_PER_PREFIX);
  });

  it('passes the calls left, charges the calls used, and reports the budget code', async () => {
    const seen: { now: number; maxCalls: number }[] = [];
    const worker = {
      async sandboxInventory(input: { now: number; maxCalls: number }) {
        seen.push(input);
        return { accounts: 0, live: 0, stoppedExecutor: 0, stoppedEphemeral: 0, orphans: 0, alerts: ['sandbox_inventory_budget_exhausted'], callsUsed: 7 };
      },
    } as unknown as SandboxReapWorker;
    const codes: string[] = [];
    const job = sandboxInventoryJob(worker, { mode: parseSandboxReapMode('on'), reportError: (_e, c) => void codes.push(String(c.code)) });
    const { ctx, spent } = ctxWith(job.maxCalls, 0);
    await job.run(ctx);
    expect(seen[0]!.maxCalls).toBe(SANDBOX_INVENTORY_CALLS_PER_RUN);
    expect(spent()).toBe(7);
    expect(codes).toEqual(['sandbox_inventory_budget_exhausted']);
  });
});
