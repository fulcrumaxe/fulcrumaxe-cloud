import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { plannedFixture } from '@fx/db/test/helpers/plannedChildren.js';
import { setPendingHooks } from '../src/pendingWork.js';
import { withTenant } from '../src/tenancy/withTenant.js';
import { recordStage } from '../src/work-items/recordStage.js';

/**
 * A move out of a stage that holds a build slot wakes the parked-stage sweep (which starts the oldest orphaned waiter of the repository). A move that does not free a
 * slot, and a duplicate of a move that did, leave the marker alone. Merge, close and a person's close all come through recordStage, on either plane.
 */
describe('recordStage wakes the slot wake when a build slot frees [pg]', () => {
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

  const pending = () => [...markers.keys()].filter((k) => k === 'pending:stage-resume-sweep');
  let n = 0;
  async function item(stage: string): Promise<string> {
    const id = randomUUID();
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'feature', 'internal', $4, $5)", [id, refs.accountId, refs.repoId, stage, 8000 + n++]);
    return id;
  }
  const move = async (workItemId: string, toStage: 'merged' | 'closed_unmerged' | 'needs_human' | 'pr_opened' | 'closed', sourceRef = `t:${randomUUID()}`) => {
    const result = await withTenant(appPool, refs.accountId, (client) => recordStage(client, { workItemId, toStage, at: new Date(), source: 'webhook', sourceRef }));
    await Promise.resolve();
    return result;
  };

  it.each([
    ['pr_opened', 'merged'],
    ['pr_opened', 'closed_unmerged'],
    ['changes_requested', 'merged'],
    ['review_passed', 'merged'],
    ['in_progress', 'needs_human'],
  ] as const)('a move from %s to %s marks the sweep pending', async (from, to) => {
    await move(await item(from), to);
    expect(pending()).toEqual(['pending:stage-resume-sweep']);
  });

  it('D#483 S5-b2c-2: a planned PR child that merges wakes the auto-start sweep (a sibling may now launch); an ordinary item that merges does not', async () => {
    const sweep = 'pending:proposal-verify-sweep';
    await move(await item('pr_opened'), 'merged');
    expect(markers.has(sweep)).toBe(false);
    const f = await plannedFixture(admin, appPool, { dial: null, weeklyUsd: null });
    const child = f.kids.api!;
    await admin.query("UPDATE work_items SET stage = 'pr_opened' WHERE id = $1", [child]);
    await withTenant(appPool, f.t.accountId, (client) => recordStage(client, { workItemId: child, toStage: 'merged', at: new Date(), source: 'webhook', sourceRef: `t:${randomUUID()}` }));
    await Promise.resolve();
    expect(markers.has(sweep)).toBe(true);
  });

  it('a move that frees nothing marks nothing, and a duplicate of a freeing move does not mark again', async () => {
    await move(await item('in_progress'), 'pr_opened');
    await move(await item('needs_human'), 'closed');
    expect(pending()).toEqual([]);
    const id = await item('pr_opened');
    await move(id, 'merged', 'dup:slot');
    markers.clear();
    expect(await move(id, 'merged', 'dup:slot')).toEqual({ recorded: false, reason: 'duplicate' });
    expect(pending()).toEqual([]);
  });
});
