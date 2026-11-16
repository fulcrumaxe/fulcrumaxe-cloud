import { describe, expect, it } from 'vitest';
import { readConflictState } from '../../src/work-items/mergeReadiness.js';

/**
 * D#483 S5-j2e-RUNNER: what the card is told about the round of a runner's plane-merge order held for an overlap. The reads are scripted by the table each asks for; the decisions under
 * test are the function's: no queue entry, an open round with no outcome, and an order whose latest word is the overlap stop.
 */
type Row = Record<string, unknown>;
const client = (rows: { entries?: Row[]; rounds?: Row[]; orders?: Row[] }) =>
  ({
    query: async (sql: string) => ({ rows: /merge_queue_entries/.test(sql) ? (rows.entries ?? []) : /merge_conflict_rounds/.test(sql) ? (rows.rounds ?? []) : /plane_merge_orders/.test(sql) ? (rows.orders ?? []) : [] }),
  }) as never;
const BLOCKED = { state: 'blocked', outcome_code: 'overlap_unreviewed' };

describe('readConflictState for an item with no queue entry', () => {
  it('a round whose merge is still being made says overlap; once judged (its merge commit is recorded) it says overlap_review', async () => {
    const running = await readConflictState(client({ rounds: [{ round: 1, base_ref: 'main', to_sha: null }], orders: [BLOCKED] }), 'a', 'w', 2);
    expect(running).toEqual({ conflict_round: { running: true, kind: 'overlap', attempt: 1, of: 2, base_ref: 'main' } });
    const reviewing = await readConflictState(client({ rounds: [{ round: 2, base_ref: 'main', to_sha: 'b'.repeat(40) }], orders: [BLOCKED] }), 'a', 'w', 2);
    expect(reviewing).toEqual({ conflict_round: { running: true, kind: 'overlap_review', attempt: 2, of: 2, base_ref: 'main' } });
  });

  it('says nothing without an open round, or when the latest order is not the overlap block', async () => {
    expect(await readConflictState(client({ orders: [BLOCKED] }), 'a', 'w', 2)).toBeNull();
    for (const order of [undefined, { state: 'merged', outcome_code: null }, { state: 'blocked', outcome_code: 'ci_not_green' }, { state: 'failed', outcome_code: 'merge_conflict_runner' }]) {
      expect(await readConflictState(client({ rounds: [{ round: 1, base_ref: 'main', to_sha: null }], orders: order ? [order] : [] }), 'a', 'w', 2)).toBeNull();
    }
  });
});
