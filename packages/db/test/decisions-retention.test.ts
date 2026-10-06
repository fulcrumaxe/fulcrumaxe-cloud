import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { pruneDecisionReceipts, RECEIPT_RETENTION_MONTHS } from '../src/decisions.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

/**
 * DP2 item 8 / DP-OD5 / C5: a documented, tested pruning query deletes
 * decision_receipts rows older than 24 months and nothing younger, and is
 * independent of any run-retention job -- the run this test's receipts
 * reference is never touched by pruneDecisionReceipts().
 */
describe('pruneDecisionReceipts: 24-month retention, independent of run retention', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let refs: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    refs = await seedAccount(admin, randomUUID());
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
  });

  it('retention is 24 months (DP-OD5)', () => {
    expect(RECEIPT_RETENTION_MONTHS).toBe(24);
  });

  it('deletes receipts older than 24 months and leaves everything younger', async () => {
    const oldId = randomUUID();
    const youngId = randomUUID();

    // 25 months old -- past the cutoff. Inserted with an explicit
    // created_at (the admin connection bypasses RLS and the column
    // default) so the assertion doesn't depend on wall-clock timing.
    await admin.query(
      `INSERT INTO decision_receipts (id, account_id, run_id, work_item_id, decision_type, class, created_at)
       VALUES ($1, $2, $3, $4, 'merge.fast-path', 'human_over_the_loop', now() - interval '25 months')`,
      [oldId, refs.accountId, refs.runId, refs.workItemId],
    );
    // 23 months old -- inside the retention window.
    await admin.query(
      `INSERT INTO decision_receipts (id, account_id, run_id, work_item_id, decision_type, class, created_at)
       VALUES ($1, $2, $3, $4, 'merge.fast-path', 'human_over_the_loop', now() - interval '23 months')`,
      [youngId, refs.accountId, refs.runId, refs.workItemId],
    );

    const result = await pruneDecisionReceipts(admin);
    expect(result.deleted).toBeGreaterThanOrEqual(1);

    const { rows: remaining } = await admin.query<{ id: string }>(
      `SELECT id FROM decision_receipts WHERE account_id = $1`,
      [refs.accountId],
    );
    const remainingIds = remaining.map((r) => r.id);
    expect(remainingIds).not.toContain(oldId);
    expect(remainingIds).toContain(youngId);
  });

  it('is independent of run retention: the referenced agent_runs row is never touched by pruning', async () => {
    const { rows } = await admin.query('SELECT 1 FROM agent_runs WHERE id = $1', [refs.runId]);
    expect(rows).toHaveLength(1);
  });

  /**
   * D#7 DP2 fix round 3 (security review needs-fix on PR #54, SUGGESTION
   * item 6): retentionMonths used to be passed straight into the DELETE
   * with no floor, so a caller-supplied 0 or a negative number deleted
   * every receipt regardless of age. pruneDecisionReceipts() now refuses
   * anything below RECEIPT_RETENTION_MONTHS (24) before running any
   * query -- no partial deletion on a rejected call.
   */
  describe('retentionMonths floor (fix round 3, SUGGESTION item 6)', () => {
    it.each([0, -1, 23])(
      'refuses retentionMonths=%i and deletes nothing',
      async (retentionMonths) => {
        const veryOldId = randomUUID();
        await admin.query(
          `INSERT INTO decision_receipts (id, account_id, run_id, work_item_id, decision_type, class, created_at)
           VALUES ($1, $2, $3, $4, 'merge.fast-path', 'human_over_the_loop', now() - interval '99 months')`,
          [veryOldId, refs.accountId, refs.runId, refs.workItemId],
        );

        await expect(pruneDecisionReceipts(admin, retentionMonths)).rejects.toThrow(
          /below the DP-OD5 floor/,
        );

        const { rows } = await admin.query('SELECT 1 FROM decision_receipts WHERE id = $1', [veryOldId]);
        expect(rows).toHaveLength(1);
      },
    );

    it('accepts retentionMonths exactly at the floor (24)', async () => {
      const atFloorId = randomUUID();
      await admin.query(
        `INSERT INTO decision_receipts (id, account_id, run_id, work_item_id, decision_type, class, created_at)
         VALUES ($1, $2, $3, $4, 'merge.fast-path', 'human_over_the_loop', now() - interval '25 months')`,
        [atFloorId, refs.accountId, refs.runId, refs.workItemId],
      );

      await expect(pruneDecisionReceipts(admin, RECEIPT_RETENTION_MONTHS)).resolves.toBeDefined();

      const { rows } = await admin.query('SELECT 1 FROM decision_receipts WHERE id = $1', [atFloorId]);
      expect(rows).toHaveLength(0);
    });

    it('accepts a retentionMonths above the floor', async () => {
      await expect(pruneDecisionReceipts(admin, 36)).resolves.toBeDefined();
    });
  });
});
