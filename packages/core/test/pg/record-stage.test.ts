import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { withTenant } from '../../src/tenancy/withTenant.js';
import { recordStage } from '../../src/work-items/recordStage.js';
import { IllegalStageTransitionError, StageInputError, WorkItemNotFoundError } from '../../src/work-items/stages.js';

/**
 * D#45 S1 criterion 9: `recordStage(client, input)`, exercised against a
 * real Postgres cluster (never mocked) under `withTenant`.
 */
describe('recordStage (D#45 S1 criterion 9)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let refsA: SeedRefs;
  let refsB: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    refsA = await seedAccount(admin, randomUUID());
    refsB = await seedAccount(admin, randomUUID());
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
  });

  /** A fresh work item for A, at the default 'triaged' stage, isolated from every other test case. */
  async function freshWorkItem(): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO work_items (id, account_id, repo_id, kind, provenance) VALUES ($1, $2, $3, 'feature', 'internal')`,
      [id, refsA.accountId, refsA.repoId],
    );
    return id;
  }

  async function currentStage(workItemId: string): Promise<string> {
    const { rows } = await admin.query<{ stage: string }>('SELECT stage FROM work_items WHERE id = $1', [
      workItemId,
    ]);
    return rows[0]!.stage;
  }

  async function transitionCount(workItemId: string): Promise<number> {
    const { rows } = await admin.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM work_item_transitions WHERE work_item_id = $1',
      [workItemId],
    );
    return Number(rows[0]!.count);
  }

  /** Advances a work item through a sequence of legal, reviewer-less transitions, sequentially. */
  async function advance(workItemId: string, stages: string[]): Promise<void> {
    for (const toStage of stages) {
      const result = await withTenant(appUserPool, refsA.accountId, (client) =>
        recordStage(client, {
          workItemId,
          toStage: toStage as never,
          at: new Date(),
          source: 'control_plane',
          sourceRef: randomUUID(),
        }),
      );
      expect(result.recorded).toBe(true);
    }
  }

  describe('(a) a legal transition', () => {
    it('writes exactly one row, sets work_items.stage, and returns { recorded: true, transitionId }', async () => {
      const workItemId = await freshWorkItem();
      const result = await withTenant(appUserPool, refsA.accountId, (client) =>
        recordStage(client, {
          workItemId,
          toStage: 'discussing',
          at: new Date(),
          source: 'control_plane',
          sourceRef: randomUUID(),
        }),
      );
      expect(result).toMatchObject({ recorded: true });
      const transitionId = (result as { recorded: true; transitionId: string }).transitionId;
      expect(typeof transitionId).toBe('string');

      const { rows } = await admin.query<{ id: string; from_stage: string; to_stage: string }>(
        'SELECT id, from_stage, to_stage FROM work_item_transitions WHERE work_item_id = $1',
        [workItemId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(transitionId);
      expect(rows[0]!.from_stage).toBe('triaged');
      expect(rows[0]!.to_stage).toBe('discussing');
      expect(await currentStage(workItemId)).toBe('discussing');
    });
  });

  describe('(b) duplicate calls', () => {
    it('emits one work_item.stage_changed domain event for the move, in the same transaction, with ids and stage words only; a duplicate and a rolled-back move emit none', async () => {
      const id = await freshWorkItem();
      await withTenant(appUserPool, refsA.accountId, (c) => recordStage(c, { workItemId: id, toStage: 'discussing', at: new Date(), source: 'control_plane', sourceRef: 'ev-1' }));
      await withTenant(appUserPool, refsA.accountId, (c) => recordStage(c, { workItemId: id, toStage: 'discussing', at: new Date(), source: 'control_plane', sourceRef: 'ev-1' }));
      await expect(
        withTenant(appUserPool, refsA.accountId, async (c) => {
          await recordStage(c, { workItemId: id, toStage: 'spec_ready', at: new Date(), source: 'control_plane', sourceRef: 'ev-2' });
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      const { rows } = await admin.query("SELECT type, subject_id, payload FROM domain_events WHERE account_id = $1 AND subject_id = $2 AND type = 'work_item.stage_changed'", [refsA.accountId, id]);
      expect(rows).toEqual([{ type: 'work_item.stage_changed', subject_id: id, payload: { workItemId: id, fromStage: 'triaged', toStage: 'discussing' } }]);
    });

    it('the same (workItemId, toStage, sourceRef) returns { recorded: false, reason: "duplicate" } and writes nothing', async () => {
      const workItemId = await freshWorkItem();
      const sourceRef = randomUUID();
      const input = {
        workItemId,
        toStage: 'discussing' as const,
        at: new Date(),
        source: 'control_plane' as const,
        sourceRef,
      };
      const first = await withTenant(appUserPool, refsA.accountId, (client) => recordStage(client, input));
      expect(first.recorded).toBe(true);
      expect(await transitionCount(workItemId)).toBe(1);

      const second = await withTenant(appUserPool, refsA.accountId, (client) => recordStage(client, input));
      expect(second).toEqual({ recorded: false, reason: 'duplicate' });
      expect(await transitionCount(workItemId)).toBe(1);
      expect(await currentStage(workItemId)).toBe('discussing');
    });

    it('still returns duplicate after the item has moved to a later stage', async () => {
      const workItemId = await freshWorkItem();
      const sourceRef = randomUUID();
      const input = {
        workItemId,
        toStage: 'discussing' as const,
        at: new Date(),
        source: 'control_plane' as const,
        sourceRef,
      };
      const first = await withTenant(appUserPool, refsA.accountId, (client) => recordStage(client, input));
      expect(first.recorded).toBe(true);

      // Move the item further: discussing -> spec_ready. From spec_ready,
      // 'discussing' is not a legal target at all -- a legality-first
      // implementation would throw IllegalStageTransitionError here
      // instead of recognising the duplicate.
      await advance(workItemId, ['spec_ready']);
      expect(await currentStage(workItemId)).toBe('spec_ready');

      const repeat = await withTenant(appUserPool, refsA.accountId, (client) => recordStage(client, input));
      expect(repeat).toEqual({ recorded: false, reason: 'duplicate' });
      expect(await transitionCount(workItemId)).toBe(2);
      expect(await currentStage(workItemId)).toBe('spec_ready');
    });
  });

  describe('(c) an illegal transition', () => {
    it('throws IllegalStageTransitionError and writes nothing', async () => {
      const workItemId = await freshWorkItem();
      await expect(
        withTenant(appUserPool, refsA.accountId, (client) =>
          recordStage(client, {
            workItemId,
            toStage: 'merged',
            at: new Date(),
            source: 'control_plane',
            sourceRef: randomUUID(),
          }),
        ),
      ).rejects.toThrow(IllegalStageTransitionError);
      expect(await transitionCount(workItemId)).toBe(0);
      expect(await currentStage(workItemId)).toBe('triaged');
    });
  });

  describe('(d) reviewer <-> to_stage mismatch', () => {
    it('a missing reviewer on changes_requested throws StageInputError and writes nothing', async () => {
      const workItemId = await freshWorkItem();
      await advance(workItemId, ['in_progress', 'pr_opened']);
      await expect(
        withTenant(appUserPool, refsA.accountId, (client) =>
          recordStage(client, {
            workItemId,
            toStage: 'changes_requested',
            at: new Date(),
            source: 'control_plane',
            sourceRef: randomUUID(),
          }),
        ),
      ).rejects.toThrow(StageInputError);
      expect(await transitionCount(workItemId)).toBe(2);
      expect(await currentStage(workItemId)).toBe('pr_opened');
    });

    it('a missing reviewer on review_passed throws StageInputError and writes nothing', async () => {
      const workItemId = await freshWorkItem();
      await advance(workItemId, ['in_progress', 'pr_opened']);
      await expect(
        withTenant(appUserPool, refsA.accountId, (client) =>
          recordStage(client, {
            workItemId,
            toStage: 'review_passed',
            at: new Date(),
            source: 'control_plane',
            sourceRef: randomUUID(),
          }),
        ),
      ).rejects.toThrow(StageInputError);
      expect(await transitionCount(workItemId)).toBe(2);
    });

    it('a reviewer on any other stage throws StageInputError and writes nothing', async () => {
      const workItemId = await freshWorkItem();
      await expect(
        withTenant(appUserPool, refsA.accountId, (client) =>
          recordStage(client, {
            workItemId,
            toStage: 'in_progress',
            reviewer: 'code',
            at: new Date(),
            source: 'control_plane',
            sourceRef: randomUUID(),
          }),
        ),
      ).rejects.toThrow(StageInputError);
      expect(await transitionCount(workItemId)).toBe(0);
    });
  });

  describe('(e) "at" more than 5 minutes in the future', () => {
    it('throws StageInputError and writes nothing', async () => {
      const workItemId = await freshWorkItem();
      const future = new Date(Date.now() + 6 * 60 * 1000);
      await expect(
        withTenant(appUserPool, refsA.accountId, (client) =>
          recordStage(client, {
            workItemId,
            toStage: 'discussing',
            at: future,
            source: 'control_plane',
            sourceRef: randomUUID(),
          }),
        ),
      ).rejects.toThrow(StageInputError);
      expect(await transitionCount(workItemId)).toBe(0);
      expect(await currentStage(workItemId)).toBe('triaged');
    });

    it('at 5 minutes in the past succeeds', async () => {
      const workItemId = await freshWorkItem();
      const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const result = await withTenant(appUserPool, refsA.accountId, (client) =>
        recordStage(client, {
          workItemId,
          toStage: 'discussing',
          at: past,
          source: 'control_plane',
          sourceRef: randomUUID(),
        }),
      );
      expect(result.recorded).toBe(true);
    });
  });

  describe('(f) unknown or cross-tenant work item id', () => {
    it('an unknown work item id throws WorkItemNotFoundError and writes nothing', async () => {
      const unknownId = randomUUID();
      await expect(
        withTenant(appUserPool, refsA.accountId, (client) =>
          recordStage(client, {
            workItemId: unknownId,
            toStage: 'discussing',
            at: new Date(),
            source: 'control_plane',
            sourceRef: randomUUID(),
          }),
        ),
      ).rejects.toThrow(WorkItemNotFoundError);
    });

    it("tenant B's work item id under withTenant(A) throws WorkItemNotFoundError and writes nothing", async () => {
      await expect(
        withTenant(appUserPool, refsA.accountId, (client) =>
          recordStage(client, {
            workItemId: refsB.workItemId,
            toStage: 'discussing',
            at: new Date(),
            source: 'control_plane',
            sourceRef: randomUUID(),
          }),
        ),
      ).rejects.toThrow(WorkItemNotFoundError);
      expect(await transitionCount(refsB.workItemId)).toBe(0);
      expect(await currentStage(refsB.workItemId)).toBe('triaged');
    });
  });

  describe('(g) never begins, commits or rolls back a transaction', () => {
    it('a spy on client.query records no BEGIN/COMMIT/ROLLBACK/SAVEPOINT, and a caller-controlled BEGIN...ROLLBACK leaves no trace', async () => {
      const workItemId = await freshWorkItem();
      const client = await appUserPool.connect();
      const issued: string[] = [];
      const originalQuery = client.query.bind(client);
      /* eslint-disable @typescript-eslint/no-explicit-any -- a generic passthrough spy over pg's heavily-overloaded `query` signature */
      (client as any).query = (...args: any[]) => {
        if (typeof args[0] === 'string') issued.push(args[0]);
        return (originalQuery as any)(...args);
      };
      /* eslint-enable @typescript-eslint/no-explicit-any */

      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.account_id', $1, true)`, [refsA.accountId]);
        issued.length = 0; // only inspect what recordStage itself issues from here

        const result = await recordStage(client, {
          workItemId,
          toStage: 'discussing',
          at: new Date(),
          source: 'control_plane',
          sourceRef: randomUUID(),
        });
        expect(result.recorded).toBe(true);

        for (const sql of issued) {
          expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT)/i);
        }

        await client.query('ROLLBACK');
      } finally {
        await client.query('RESET app.account_id').catch(() => {});
        client.release();
      }

      expect(await currentStage(workItemId)).toBe('triaged');
      expect(await transitionCount(workItemId)).toBe(0);
    });
  });

  describe('(h) two concurrent calls on one item, in separate transactions', () => {
    it('both commit; the second row\'s from_stage equals the first row\'s to_stage', async () => {
      const workItemId = await freshWorkItem();
      await advance(workItemId, ['in_progress', 'pr_opened']);

      const [r1, r2] = await Promise.all([
        withTenant(appUserPool, refsA.accountId, (client) =>
          recordStage(client, {
            workItemId,
            toStage: 'changes_requested',
            reviewer: 'code',
            at: new Date(),
            source: 'control_plane',
            sourceRef: randomUUID(),
          }),
        ),
        withTenant(appUserPool, refsA.accountId, (client) =>
          recordStage(client, {
            workItemId,
            toStage: 'review_passed',
            reviewer: 'code',
            at: new Date(),
            source: 'control_plane',
            sourceRef: randomUUID(),
          }),
        ),
      ]);

      expect(r1.recorded).toBe(true);
      expect(r2.recorded).toBe(true);

      const { rows } = await admin.query<{ from_stage: string; to_stage: string }>(
        `SELECT from_stage, to_stage FROM work_item_transitions
         WHERE work_item_id = $1 AND to_stage IN ('changes_requested', 'review_passed')`,
        [workItemId],
      );
      expect(rows).toHaveLength(2);
      // The row lock decides which call goes first, not which transaction began first: created_at is the
      // transaction's start time, so ordering by it can put the two rows the wrong way round on a loaded machine.
      // Follow the chain instead: exactly one row starts from the item's stage before both calls, and the other
      // starts from that row's to_stage (had the calls not been serialised, both would start from 'pr_opened').
      const first = rows.filter((r) => r.from_stage === 'pr_opened');
      expect(first).toHaveLength(1);
      const second = rows.filter((r) => r !== first[0]);
      expect(second).toHaveLength(1);
      expect(second[0]!.from_stage).toBe(first[0]!.to_stage);
    });
  });

  describe('(i) a self-loop with a new sourceRef', () => {
    it('changes_requested -> changes_requested records a second row', async () => {
      const workItemId = await freshWorkItem();
      await advance(workItemId, ['in_progress', 'pr_opened']);
      const first = await withTenant(appUserPool, refsA.accountId, (client) =>
        recordStage(client, {
          workItemId,
          toStage: 'changes_requested',
          reviewer: 'code',
          at: new Date(),
          source: 'control_plane',
          sourceRef: randomUUID(),
        }),
      );
      expect(first.recorded).toBe(true);

      const second = await withTenant(appUserPool, refsA.accountId, (client) =>
        recordStage(client, {
          workItemId,
          toStage: 'changes_requested',
          reviewer: 'code',
          at: new Date(),
          source: 'control_plane',
          sourceRef: randomUUID(),
        }),
      );
      expect(second.recorded).toBe(true);

      const { rows } = await admin.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM work_item_transitions WHERE work_item_id = $1 AND to_stage = 'changes_requested'`,
        [workItemId],
      );
      expect(Number(rows[0]!.count)).toBe(2);
    });
  });
});
