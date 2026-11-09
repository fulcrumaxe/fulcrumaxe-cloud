import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { setPendingHooks } from '../src/pendingWork.js';
import { withTenant } from '../src/tenancy/withTenant.js';
import { recordStage } from '../src/work-items/recordStage.js';

/**
 * D#749 V3a: a merge in a repository whose post-merge verification is on sets the verifier tick's existing hint (no sweep name of its own), so the verify pass opens the row
 * soon. A merge anywhere else, and every other move, leaves the hint alone. It is a hint only: the pass reads the rows.
 */
describe('recordStage wakes the verify stage on a merge [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;
  let markers: Map<string, number>;
  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
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

  const woken = () => markers.has('pending:proposal-verify-sweep');
  let n = 0;
  async function repo(who: SeedRefs, enabled: boolean | null): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, $4, 'team')`, [id, who.accountId, who.installationId, Math.floor(Math.random() * 1e9) + 10]);
    if (enabled !== null) await admin.query(`INSERT INTO verify_settings (repo_id, account_id, enabled, base_url) VALUES ($1, $2, $3, 'https://app.example')`, [id, who.accountId, enabled]);
    return id;
  }
  async function item(who: SeedRefs, repoId: string, stage: string): Promise<string> {
    const id = randomUUID();
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'feature', 'internal', $4, $5)", [id, who.accountId, repoId, stage, 7000 + n++]);
    return id;
  }
  const move = async (who: SeedRefs, workItemId: string, toStage: 'merged' | 'pr_opened', sourceRef = `t:${randomUUID()}`) => {
    await withTenant(appPool, who.accountId, (client) => recordStage(client, { workItemId, toStage, at: new Date(), source: 'webhook', sourceRef }));
    await Promise.resolve();
  };

  it('a merge in a repository with verification on marks the verifier tick pending', async () => {
    await move(a, await item(a, await repo(a, true), 'pr_opened'), 'merged');
    expect(woken()).toBe(true);
  });

  it('a merge where verification is off (switched off, or never configured) marks nothing for it; neither does a move that is not a merge', async () => {
    await move(a, await item(a, await repo(a, false), 'pr_opened'), 'merged');
    await move(a, await item(a, await repo(a, null), 'pr_opened'), 'merged');
    expect(woken()).toBe(false);
    await move(a, await item(a, await repo(a, true), 'in_progress'), 'pr_opened');
    expect(woken()).toBe(false);
  });

  it('another account having verification on does not wake this account\'s merge, and the sweep name is the existing one', async () => {
    await repo(b, true);
    await move(a, await item(a, await repo(a, null), 'pr_opened'), 'merged');
    expect(woken()).toBe(false);
  });
});
