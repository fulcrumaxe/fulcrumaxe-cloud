import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { setPendingHooks } from '../src/pendingWork.js';
import { withTenant } from '../src/tenancy/withTenant.js';
import { recordStage } from '../src/work-items/recordStage.js';

/**
 * D#598 P1f-5d: the trigger of the branch cleanup. A move to a final stage (merged, closed_unmerged, closed) marks the cleanup sweep pending; every other
 * move, and a duplicate of a move, leaves the marker alone. The marker is a hint: the stage is read again by the sweep (packages/worker).
 */
describe('recordStage wakes the branch cleanup [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let refs: SeedRefs;
  let markers: Map<string, number>;
  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    refs = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appPool.end();
  });
  beforeEach(() => {
    markers = new Map();
    setPendingHooks({ store: { get: async (k) => markers.get(k) ?? null, set: async (k, v) => void markers.set(k, v), delete: async (k) => void markers.delete(k) } });
  });
  afterEach(() => setPendingHooks(null));

  /** The domain event of a move also wakes the API sweep; only this sweep's marker matters here. */
  const pending = () => [...markers.keys()].filter((k) => k === 'pending:branch-cleanup');
  let n = 0;
  async function item(stage: string): Promise<string> {
    const id = randomUUID();
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'feature', 'internal', $4, $5)", [id, refs.accountId, refs.repoId, stage, 5000 + n++]);
    return id;
  }
  const move = async (workItemId: string, toStage: 'merged' | 'closed_unmerged' | 'closed' | 'pr_opened' | 'changes_requested', sourceRef = `t:${randomUUID()}`) => {
    const result = await withTenant(appPool, refs.accountId, (client) => recordStage(client, { workItemId, toStage, at: new Date(), source: 'webhook', sourceRef, ...(toStage === 'changes_requested' ? { reviewer: 'code' as const } : {}) }));
    await Promise.resolve();
    return result;
  };

  it.each([
    ['pr_opened', 'merged'],
    ['pr_opened', 'closed_unmerged'],
    ['needs_human', 'closed'],
  ] as const)('a move from %s to %s marks branch-cleanup pending', async (from, to) => {
    const id = await item(from);
    await move(id, to);
    expect(pending()).toEqual(['pending:branch-cleanup']);
  });

  it('a move to a stage that is not final marks nothing, and a duplicate of a final move does not mark again', async () => {
    await move(await item('in_progress'), 'pr_opened');
    await move(await item('review_passed'), 'changes_requested');
    expect(pending()).toEqual([]);
    const id = await item('pr_opened');
    await move(id, 'merged', 'dup:1');
    markers.clear();
    expect(await move(id, 'merged', 'dup:1')).toEqual({ recorded: false, reason: 'duplicate' });
    expect(pending()).toEqual([]);
  });
});
