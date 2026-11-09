import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { setPendingHooks } from '../src/pendingWork.js';
import { withTenant } from '../src/tenancy/withTenant.js';
import { recordDriverEvent, type DriverEventInput } from '../src/work-items/driverEvents.js';

/** A stop only a person can restart frees the item's build slot, so it wakes the parked-stage sweep at once; nothing else does. */
describe('recordDriverEvent wakes the slot wake on a person-only stop [pg]', () => {
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
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'feature', 'internal', $4, $5)", [id, refs.accountId, refs.repoId, stage, 9000 + n++]);
    return id;
  }
  const write = async (workItemId: string, kind: DriverEventInput['kind'], code: string | null, dedupeKey: string = randomUUID()) => {
    const out = await withTenant(appPool, refs.accountId, (client) => recordDriverEvent(client, refs.accountId, { workItemId, kind, dedupeKey, ...(code !== null ? { code } : {}) }));
    await Promise.resolve();
    return out;
  };

  it.each([
    ['pr_opened', 'stopped', 'reviewer_environment'],
    ['changes_requested', 'escalated', 'reviewer_fail'],
    ['review_passed', 'stopped', 'not_started_no_model'],
  ] as const)('a %s item with a %s fact (%s) marks the sweep pending', async (stage, kind, code) => {
    await write(await item(stage), kind, code);
    expect(pending()).toEqual(['pending:stage-resume-sweep']);
  });

  it('a replay of the same fact wakes nothing', async () => {
    const id = await item('pr_opened');
    await write(id, 'stopped', 'reviewer_environment', 'same');
    markers.clear();
    expect((await write(id, 'stopped', 'reviewer_environment', 'same')).recorded).toBe(false);
    expect(pending()).toEqual([]);
  });

  it.each([
    ['pr_opened', 'stopped', 'build_wait_timeout'],
    ['pr_opened', 'stopped', 'merge_gate'],
    ['pr_opened', 'review_started', null],
    ['needs_human', 'escalated', 'reviewer_fail'],
    ['in_progress', 'stopped', 'reviewer_environment'],
  ] as const)('a %s item with a %s fact (%s) wakes nothing', async (stage, kind, code) => {
    await write(await item(stage), kind, code);
    expect(pending()).toEqual([]);
  });
});
