import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { applyPromotionDecision, saveProposedTable } from '../src/proposal.js';
import type { RoutingRow } from '../src/types.js';

describe('[pg] saveProposedTable + applyPromotionDecision', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createPool(process.env.DATABASE_URL!);
  });

  afterEach(async () => {
    await pool.query("DELETE FROM routing_tables WHERE status IN ('proposed', 'rejected', 'retired') AND version <> 1");
  });

  const rows: RoutingRow[] = [{ role: 'executor', size: 'Small', model: 'haiku-4.5', rationale: 'proposal fixture' }];

  it('rejects saving a table with security-reviewer on Haiku, and never touches the database', async () => {
    // On 3945419, saveProposedTable inserted this row with no floor check
    // at all -- only route()'s runtime clamp caught it, later, at read
    // time.
    const floorViolatingRows: RoutingRow[] = [
      { role: 'security-reviewer', size: 'Small', model: 'haiku-4.5', rationale: 'floor violation' },
    ];
    await expect(
      saveProposedTable(pool, floorViolatingRows, { source: 'cost_analyst', successThresholdPp: 2 }),
    ).rejects.toThrow(/violates floor/);

    const { rows: proposedRows } = await pool.query("SELECT version FROM routing_tables WHERE status = 'proposed'");
    expect(proposedRows).toEqual([]);
  });

  it('stores a proposal as status = proposed', async () => {
    const version = await saveProposedTable(pool, rows, { source: 'cost_analyst', successThresholdPp: 2 });
    const { rows: tableRows } = await pool.query<{ status: string; source: string }>(
      'SELECT status, source FROM routing_tables WHERE version = $1',
      [version],
    );
    expect(tableRows[0]).toEqual({ status: 'proposed', source: 'cost_analyst' });

    const { rows: rowRows } = await pool.query('SELECT role, size, model FROM routing_rows WHERE table_version = $1', [version]);
    expect(rowRows).toEqual([{ role: 'executor', size: 'Small', model: 'haiku-4.5' }]);
  });

  it('a passing fixture is promoted: the old live version retires, the proposal goes live', async () => {
    const version = await saveProposedTable(pool, rows, { source: 'cost_analyst', successThresholdPp: 2 });
    await applyPromotionDecision(pool, version, { promote: true });

    const { rows: liveRows } = await pool.query("SELECT version FROM routing_tables WHERE status = 'live'");
    expect(liveRows).toEqual([{ version }]);

    const { rows: retiredRows } = await pool.query("SELECT version FROM routing_tables WHERE status = 'retired'");
    expect(retiredRows).toEqual([{ version: 1 }]);

    // Restore version 1 to live so every other test in this run still sees
    // the seeded default table. routing_tables_one_live is a plain
    // (non-deferrable) unique index, so the demote must commit before the
    // promote -- otherwise both rows are briefly "live" in the same
    // statement boundary and the index rejects it.
    await pool.query("UPDATE routing_tables SET status = 'retired' WHERE version = $1", [version]);
    await pool.query("UPDATE routing_tables SET status = 'live' WHERE version = 1");
  });

  it('a proposal that fails the guard is set to rejected with the reason stored, and live is unchanged', async () => {
    const version = await saveProposedTable(pool, rows, { source: 'cost_analyst', successThresholdPp: 2 });
    await applyPromotionDecision(pool, version, { promote: false, reason: 'success rate dropped too far' });

    const { rows: rejectedRows } = await pool.query<{ status: string; rejection_reason: string }>(
      'SELECT status, rejection_reason FROM routing_tables WHERE version = $1',
      [version],
    );
    expect(rejectedRows[0]).toEqual({ status: 'rejected', rejection_reason: 'success rate dropped too far' });

    const { rows: liveRows } = await pool.query("SELECT version FROM routing_tables WHERE status = 'live'");
    expect(liveRows).toEqual([{ version: 1 }]);
  });

  describe('applyPromotionDecision state check (security review Should-fix #2, CWE-841)', () => {
    it('refuses to promote an already-rejected version, and live is unchanged', async () => {
      const version = await saveProposedTable(pool, rows, { source: 'cost_analyst', successThresholdPp: 2 });
      await applyPromotionDecision(pool, version, { promote: false, reason: 'first pass: reject' });

      // On 3945419 this promote had no status guard, so it silently
      // succeeded and put a rejected version live.
      await expect(applyPromotionDecision(pool, version, { promote: true })).rejects.toThrow(/not a 'proposed' row/);

      const { rows: tableRows } = await pool.query<{ status: string }>(
        'SELECT status FROM routing_tables WHERE version = $1',
        [version],
      );
      expect(tableRows[0]).toEqual({ status: 'rejected' });

      const { rows: liveRows } = await pool.query("SELECT version FROM routing_tables WHERE status = 'live'");
      expect(liveRows).toEqual([{ version: 1 }]);
    });

    it('refuses to promote a nonexistent version, and live is unchanged (not left empty)', async () => {
      // On 3945419 this retired the live table, updated 0 rows for the
      // promote, and still committed -- leaving zero live tables.
      await expect(applyPromotionDecision(pool, 987654, { promote: true })).rejects.toThrow(/not a 'proposed' row/);

      const { rows: liveRows } = await pool.query("SELECT version FROM routing_tables WHERE status = 'live'");
      expect(liveRows).toEqual([{ version: 1 }]);
    });

    it('refuses to reject the currently-live version, and live is unchanged', async () => {
      // On 3945419 this had no status guard either, so rejecting version 1
      // (the live version) silently left zero live tables.
      await expect(
        applyPromotionDecision(pool, 1, { promote: false, reason: 'should never apply to a live row' }),
      ).rejects.toThrow(/not a 'proposed' row/);

      const { rows: liveRows } = await pool.query("SELECT version FROM routing_tables WHERE status = 'live'");
      expect(liveRows).toEqual([{ version: 1 }]);
    });
  });
});
