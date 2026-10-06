import { describe, expect, it } from 'vitest';
import { aggregateByPair, buildProposal, decidePromotion, type RunOutcomeSample } from '../src/proposal.js';
import { ALL_ROUTABLE_ROLES } from '../src/roleUniverse.js';
import type { RoutingRow, RoutingTable, Size } from '../src/types.js';

const SIZES: readonly Size[] = ['Small', 'Feature', 'Critical'];

/** A full current table where every pair defaults to sonnet-5 -- keeps
 * these fixtures independent of default-table/v1.json's real content. */
function fullCurrentTable(): RoutingTable {
  const rows: RoutingRow[] = [];
  for (const role of ALL_ROUTABLE_ROLES) {
    for (const size of SIZES) {
      rows.push({ role, size, model: 'sonnet-5', rationale: 'fixture default' });
    }
  }
  return { version: 1, rows };
}

function sample(overrides: Partial<RunOutcomeSample>): RunOutcomeSample {
  return {
    role: 'executor',
    size: 'Feature',
    model: 'sonnet-5',
    usd: 1,
    verdict: 'pass',
    prMerged: true,
    fixRounds: 0,
    ...overrides,
  };
}

describe('aggregateByPair', () => {
  it('computes n, success rate, median and p90 cost per (role, size, model)', () => {
    const samples = [
      sample({ usd: 1 }),
      sample({ usd: 2 }),
      sample({ usd: 3, verdict: 'fail', prMerged: false }),
    ];
    const [agg] = aggregateByPair(samples);
    expect(agg).toMatchObject({ role: 'executor', size: 'Feature', model: 'sonnet-5', n: 3 });
    expect(agg?.successRate).toBeCloseTo(2 / 3);
  });
});

describe('buildProposal', () => {
  it('keeps the current model for a pair with fewer than 20 runs', () => {
    const table = fullCurrentTable();
    const samples = [sample({ model: 'haiku-4.5', usd: 0.1 })]; // n=1, well under 20
    const rows = buildProposal(samples, table, 2);
    const row = rows.find((r) => r.role === 'executor' && r.size === 'Feature');
    expect(row?.model).toBe('sonnet-5'); // unchanged from the current table
    expect(row?.rationale).toMatch(/fewer than 20 runs/);
  });

  it('picks the cheapest model within threshold of the best success rate once n >= 20', () => {
    const table = fullCurrentTable();
    const samples: RunOutcomeSample[] = [];
    for (let i = 0; i < 20; i++) samples.push(sample({ model: 'sonnet-5', usd: 2, verdict: 'pass' }));
    for (let i = 0; i < 20; i++) samples.push(sample({ model: 'haiku-4.5', usd: 0.2, verdict: 'pass' }));
    const rows = buildProposal(samples, table, 2);
    const row = rows.find((r) => r.role === 'executor' && r.size === 'Feature');
    // Both models have the same (100%) success rate, so the cheaper one wins.
    expect(row?.model).toBe('haiku-4.5');
  });

  it('never proposes a model below a floored role floor', () => {
    const table = fullCurrentTable();
    const samples: RunOutcomeSample[] = [];
    for (let i = 0; i < 20; i++) {
      samples.push(sample({ role: 'security-reviewer', model: 'sonnet-5', usd: 2, verdict: 'pass' }));
    }
    const rows = buildProposal(samples, table, 2);
    const row = rows.find((r) => r.role === 'security-reviewer' && r.size === 'Feature');
    expect(row?.model).not.toBe('haiku-4.5');
  });
});

describe('decidePromotion', () => {
  const stats = [
    { role: 'executor', size: 'Feature' as Size, model: 'sonnet-5' as const, n: 30, successRate: 0.9, medianCostUsd: 2, p90CostUsd: 3 },
    { role: 'executor', size: 'Feature' as Size, model: 'haiku-4.5' as const, n: 30, successRate: 0.88, medianCostUsd: 0.2, p90CostUsd: 0.3 },
  ];
  const liveRows: RoutingRow[] = [{ role: 'executor', size: 'Feature', model: 'sonnet-5', rationale: 'live' }];

  it('promotes a proposal within the threshold', () => {
    const proposedRows: RoutingRow[] = [{ role: 'executor', size: 'Feature', model: 'haiku-4.5', rationale: 'proposed' }];
    expect(decidePromotion(proposedRows, liveRows, stats, 2)).toEqual({ promote: true });
  });

  it('rejects a proposal whose per-pair drop exceeds 5 points at n >= 20, even though the overall weighted success barely moves', () => {
    // A large, unchanged pair keeps the OVERALL weighted success within
    // threshold; a much smaller pair (still n >= 20) drops 10 points --
    // this isolates the per-pair gate from the overall-success gate above.
    const badStats = [
      { role: 'executor', size: 'Feature' as Size, model: 'sonnet-5' as const, n: 1000, successRate: 0.9, medianCostUsd: 2, p90CostUsd: 3 },
      { role: 'executor', size: 'Feature' as Size, model: 'haiku-4.5' as const, n: 1000, successRate: 0.9, medianCostUsd: 0.2, p90CostUsd: 0.3 },
      { role: 'code-reviewer', size: 'Feature' as Size, model: 'sonnet-5' as const, n: 25, successRate: 0.9, medianCostUsd: 2, p90CostUsd: 3 },
      { role: 'code-reviewer', size: 'Feature' as Size, model: 'haiku-4.5' as const, n: 25, successRate: 0.8, medianCostUsd: 0.2, p90CostUsd: 0.3 },
    ];
    const mixedLiveRows: RoutingRow[] = [
      { role: 'executor', size: 'Feature', model: 'sonnet-5', rationale: 'live' },
      { role: 'code-reviewer', size: 'Feature', model: 'sonnet-5', rationale: 'live' },
    ];
    const proposedRows: RoutingRow[] = [
      { role: 'executor', size: 'Feature', model: 'sonnet-5', rationale: 'proposed, unchanged' },
      { role: 'code-reviewer', size: 'Feature', model: 'haiku-4.5', rationale: 'proposed' },
    ];
    const decision = decidePromotion(proposedRows, mixedLiveRows, badStats, 2);
    expect(decision.promote).toBe(false);
    if (!decision.promote) expect(decision.reason).toMatch(/drops more than 5 points/);
  });

  it('rejects a proposal whose overall weighted success drops beyond the threshold', () => {
    const overallBadStats = [
      { role: 'executor', size: 'Feature' as Size, model: 'sonnet-5' as const, n: 5, successRate: 0.95, medianCostUsd: 2, p90CostUsd: 3 },
      { role: 'executor', size: 'Feature' as Size, model: 'haiku-4.5' as const, n: 5, successRate: 0.5, medianCostUsd: 0.2, p90CostUsd: 0.3 },
    ];
    const proposedRows: RoutingRow[] = [{ role: 'executor', size: 'Feature', model: 'haiku-4.5', rationale: 'proposed' }];
    const decision = decidePromotion(proposedRows, liveRows, overallBadStats, 2);
    expect(decision.promote).toBe(false);
  });
});
