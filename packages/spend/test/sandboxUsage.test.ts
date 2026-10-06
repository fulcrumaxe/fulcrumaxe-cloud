import { describe, expect, it } from 'vitest';
import { sandboxRunCost, sandboxRunUsd, sandboxSessionUsd } from '../src/sandboxUsage.js';

const base = { activeCpuMs: 0, durationMs: 0, memoryMb: 4096, egressBytes: 0, region: 'iad1' };

describe('sandboxSessionUsd', () => {
  it("prices Vercel's documented 'AI code validation' row", () => {
    // 1 CPU-minute (0.006) + 4 GB for 5 minutes (0.02) at the fixture rates.
    expect(sandboxSessionUsd({ ...base, activeCpuMs: 60_000, durationMs: 300_000 })).toBe(0.026);
  });

  it('bills provisioned memory per started minute', () => {
    expect(sandboxSessionUsd({ ...base, durationMs: 60_000 })).toBe(0.004);
    // 61 s bills 2 minutes (0.008); without the round-up it would be 0.0041.
    expect(sandboxSessionUsd({ ...base, durationMs: 61_000 })).toBe(0.008);
  });

  it('adds egress at 1e9 bytes per GB', () => {
    expect(sandboxSessionUsd({ ...base, egressBytes: 1e9 })).toBe(0.2);
  });

  it('does not price a region without a rate row', () => {
    expect(sandboxSessionUsd({ ...base, region: 'fra1' })).toBeUndefined();
    expect(sandboxSessionUsd({ ...base, region: undefined })).toBeUndefined();
  });

  it.each(['activeCpuMs', 'durationMs', 'memoryMb', 'egressBytes'] as const)('does not price a session missing %s', (field) => {
    expect(sandboxSessionUsd({ ...base, [field]: undefined })).toBeUndefined();
    expect(sandboxSessionUsd({ ...base, [field]: Number.NaN })).toBeUndefined();
    expect(sandboxSessionUsd({ ...base, [field]: -1 })).toBeUndefined();
  });
});

describe('sandboxRunUsd', () => {
  const one = { ...base, activeCpuMs: 60_000, durationMs: 300_000 };

  it('sums the run sessions', () => {
    expect(sandboxRunUsd([one, one])).toBe(0.052);
  });

  it('is undefined for a run with no session, or with any unpriced session', () => {
    expect(sandboxRunUsd([])).toBeUndefined();
    expect(sandboxRunUsd([one, { ...one, activeCpuMs: undefined }])).toBeUndefined();
    expect(sandboxRunUsd([one, { ...one, region: 'fra1' }])).toBeUndefined();
  });
});

describe('sandboxRunCost tiers', () => {
  const vercel = { ...base, activeCpuMs: 60_000, durationMs: 300_000, egressBytes: 0 };
  const self = { cpuMs: 60_000, txBytes: 1e9, uptimeMs: 299_000 };

  it("1: every provider figure present -> 'measured'", () => {
    expect(sandboxRunCost([vercel])).toEqual({ usd: 0.026, basis: 'measured' });
  });

  it("2: only the missing CPU and egress come from the in-VM counters -> 'self_measured'", () => {
    // Memory is the provider's (4096 MB x 5 min = 0.02); CPU 0.006 and 1 GB egress 0.2 are ours.
    const noCpuNoNet = { ...vercel, activeCpuMs: undefined, egressBytes: undefined };
    expect(sandboxRunCost([{ ...noCpuNoNet, selfMeasured: self }])).toEqual({ usd: 0.226, basis: 'self_measured' });
    // A figure the provider did report (egress 0) is never replaced by ours (1e9 bytes): 5 CPU-minutes 0.03 + memory 0.02.
    const noCpu = { ...vercel, activeCpuMs: undefined };
    expect(sandboxRunCost([{ ...noCpu, selfMeasured: { ...self, cpuMs: 300_000 } }])).toEqual({ usd: 0.05, basis: 'self_measured' });
  });

  it('2: memory uses our own wall time when the provider reports no duration', () => {
    const noDuration = { ...vercel, durationMs: undefined, egressBytes: undefined, selfMeasured: { ...self, txBytes: 0 }, ownDurationMs: 300_000 };
    expect(sandboxRunCost([noDuration])).toEqual({ usd: 0.026, basis: 'self_measured' });
  });

  it('2: refuses counters from a VM that restarted (uptime far below the wall time)', () => {
    const reset = { ...self, uptimeMs: 10_000 };
    const r = sandboxRunCost([{ ...vercel, activeCpuMs: undefined, selfMeasured: reset }], { reservedUsd: 1 });
    expect(r.basis).toBe('fallback');
  });

  describe("'measured' only when every input is the provider's", () => {
    it('our own wall time or the pinned memory makes it self_measured, never measured', () => {
      expect(sandboxRunCost([{ ...vercel, durationMs: undefined, ownDurationMs: 300_000 }])).toEqual({ usd: 0.026, basis: 'self_measured' });
      expect(sandboxRunCost([{ ...vercel, memoryMb: undefined }])).toEqual({ usd: 0.026, basis: 'self_measured' });
    });

    it('a missing region is unpriced in every tier: no region is assumed', () => {
      expect(sandboxRunCost([{ ...vercel, region: undefined }], { reservedUsd: 0.001 })).toEqual({ usd: 0.08, basis: 'fallback' });
    });
  });

  it('refuses counters whose uptime is more than max(30 s, 10% of wall) short of the wall time', () => {
    const noCpu = { ...vercel, activeCpuMs: undefined };
    const at = (uptimeMs: number) => sandboxRunCost([{ ...noCpu, selfMeasured: { ...self, uptimeMs } }], { reservedUsd: 0.001 }).basis;
    expect(at(120_000)).toBe('fallback'); // restarted 180 s into a 300 s session
    expect(at(269_999)).toBe('fallback');
    expect(at(270_000)).toBe('self_measured');
  });

  describe('forged or broken counters (the agent controls its VM)', () => {
    const noCpuNoNet = { ...vercel, activeCpuMs: undefined, egressBytes: undefined };
    const opts = { reservedUsd: 0.001 };
    // 300 s wall, 2 vCPUs: CPU bound 600 s x 1.02 = 612,000 ms; egress bound 300 s x 125 MB/s = 37.5 GB.
    const fallback = { usd: 0.08, basis: 'fallback' };

    it('a huge cpuMs falls to the fallback, and the bound is wall x vCPUs (+2%)', () => {
      expect(sandboxRunCost([{ ...noCpuNoNet, selfMeasured: { ...self, cpuMs: 1e15 } }], opts)).toEqual(fallback);
      expect(sandboxRunCost([{ ...noCpuNoNet, selfMeasured: { ...self, cpuMs: 612_001, txBytes: 0 } }], opts)).toEqual(fallback);
      expect(sandboxRunCost([{ ...noCpuNoNet, selfMeasured: { ...self, cpuMs: 612_000, txBytes: 0 } }], opts).basis).toBe('self_measured');
    });

    it('a huge txBytes falls to the fallback, and the bound is wall seconds x 125 MB/s', () => {
      expect(sandboxRunCost([{ ...noCpuNoNet, selfMeasured: { ...self, txBytes: 1e15 } }], opts)).toEqual(fallback);
      expect(sandboxRunCost([{ ...noCpuNoNet, selfMeasured: { ...self, txBytes: 37.5e9 + 1 } }], opts)).toEqual(fallback);
      expect(sandboxRunCost([{ ...noCpuNoNet, selfMeasured: { ...self, txBytes: 37.5e9 } }], opts).basis).toBe('self_measured');
    });

    it('forged 0/0 settles at exactly the reservation, never below it', () => {
      const zero = { ...noCpuNoNet, selfMeasured: { cpuMs: 0, txBytes: 0, uptimeMs: 299_000 } };
      expect(sandboxRunCost([zero], { reservedUsd: 0.5 })).toEqual({ usd: 0.5, basis: 'self_measured' });
    });

    it('a realistic reading above the floor gives the computed value; the only rule is reserved <= self_measured', () => {
      // The tier-3 bound has no egress term, so a genuine reading with real egress may exceed it: no upper ordering.
      const real = { ...noCpuNoNet, selfMeasured: self };
      expect(sandboxRunCost([real], opts)).toEqual({ usd: 0.226, basis: 'self_measured' });
      expect(sandboxRunCost([real], { reservedUsd: 0.5 }).usd).toBe(0.5);
    });
  });

  it("3: neither source -> the worst-case bound, floored at the reservation, basis 'fallback'", () => {
    const none = { ...base, activeCpuMs: undefined, egressBytes: undefined, durationMs: 3_600_000 };
    // 1 h: 2 vCPU x 0.36 + 4 GB x 0.06 = 0.96.
    expect(sandboxRunCost([none], { runWallMs: 3_600_000 })).toEqual({ usd: 0.96, basis: 'fallback' });
    expect(sandboxRunCost([none], { runWallMs: 3_600_000, reservedUsd: 1 })).toEqual({ usd: 1, basis: 'fallback' });
    expect(sandboxRunCost([], { reservedUsd: 0.5 })).toEqual({ usd: 0.5, basis: 'fallback' });
  });

  it('3: any unpriced session sends the whole run to the fallback', () => {
    const r = sandboxRunCost([vercel, { ...vercel, region: 'fra1' }], { reservedUsd: 0.2 });
    expect(r).toEqual({ usd: 0.2, basis: 'fallback' });
  });
});
