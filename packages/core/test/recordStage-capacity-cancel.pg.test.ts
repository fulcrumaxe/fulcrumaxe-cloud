import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { withTenant } from '../src/tenancy/withTenant.js';
import { recordStage } from '../src/work-items/recordStage.js';
import { WORK_ITEM_STAGES } from '../src/work-items/stages.js';

/**
 * D#483 S5-k3b (C20, C23) [pg]: closing an item, by any path that goes through recordStage, ends its waiting capacity-queue entry as `cancelled_by_person` in the
 * same transaction. Every other move (merged, closed_unmerged, a move into a working stage) leaves the entry alone: it is skipped by the claim, not ended.
 */
describe('recordStage ends a waiting capacity-queue entry when the item closes [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let refs: SeedRefs;
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

  let n = 0;
  async function waitingItem(stage: string): Promise<string> {
    const id = randomUUID();
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'feature', 'internal', $4, $5)", [id, refs.accountId, refs.repoId, stage, 9100 + n++]);
    await admin.query("INSERT INTO capacity_queue (account_id, repo_id, work_item_id, run_kind, class) VALUES ($1, $2, $3, 'build', 'hosted_sandbox')", [refs.accountId, refs.repoId, id]);
    return id;
  }
  const entry = async (item: string) => (await admin.query('SELECT ended_at, ended_reason, started_run_id FROM capacity_queue WHERE work_item_id = $1', [item])).rows[0];
  const move = (workItemId: string, toStage: 'closed' | 'merged' | 'closed_unmerged' | 'needs_human', actor: 'person' | 'automatic' = 'person', sourceRef = `t:${randomUUID()}`) =>
    withTenant(appPool, refs.accountId, (client) => recordStage(client, { workItemId, toStage, at: new Date(), source: 'control_plane', sourceRef, actor }));

  it('S5k3b-13: closing a waiting item stamps the entry cancelled_by_person', async () => {
    const item = await waitingItem('discussing');
    expect(await entry(item)).toMatchObject({ ended_at: null, ended_reason: null });
    expect(await move(item, 'closed')).toMatchObject({ recorded: true });
    const e = await entry(item);
    expect(e.ended_reason).toBe('cancelled_by_person');
    expect(e.ended_at).toBeInstanceOf(Date);
  });

  it('a close from a stage that is not the first one ends it too, and a replay of the same move changes nothing', async () => {
    const item = await waitingItem('spec_ready');
    const ref = `close:${randomUUID()}`;
    expect(await move(item, 'closed', 'person', ref)).toMatchObject({ recorded: true });
    const first = await entry(item);
    expect(first.ended_reason).toBe('cancelled_by_person');
    expect(await move(item, 'closed', 'person', ref)).toEqual({ recorded: false, reason: 'duplicate' });
    expect(await entry(item)).toEqual(first);
  });

  it('a move to any other stage leaves the entry waiting (merged, closed_unmerged and needs_human are skipped by the claim, not ended)', async () => {
    for (const [from, to] of [['pr_opened', 'merged'], ['pr_opened', 'closed_unmerged'], ['pr_opened', 'needs_human']] as const) {
      const item = await waitingItem(from);
      expect(await move(item, to, 'automatic')).toMatchObject({ recorded: true });
      expect(await entry(item)).toMatchObject({ ended_at: null, ended_reason: null, started_run_id: null });
    }
  });

  it('an item that never queued closes as before, and a started entry is not ended by the close', async () => {
    const plain = randomUUID();
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'feature', 'internal', 'discussing', $4)", [plain, refs.accountId, refs.repoId, 9100 + n++]);
    expect(await move(plain, 'closed')).toMatchObject({ recorded: true });
    const run = randomUUID();
    const item = await waitingItem('discussing');
    await admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode) VALUES ($1, $2, $3, 'executor', 'production', 'succeeded', 'sandbox')", [run, refs.accountId, item]);
    await admin.query("UPDATE capacity_queue SET claimed_at = now(), claim_expires_at = now(), started_run_id = $2 WHERE work_item_id = $1", [item, run]);
    await move(item, 'closed');
    expect(await entry(item)).toMatchObject({ ended_at: null, ended_reason: null, started_run_id: run });
  });

  it('every writer of the closed stage is recordStage, except the one SQL function that retires a superseded item (its entry is skipped by the claim, never ended)', async () => {
    expect(WORK_ITEM_STAGES).toContain('closed');
    const { rows } = await admin.query(`SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosrc ~* 'SET\\s+stage\\s*=' ORDER BY 1`);
    expect(rows.map((r) => r.proname)).toEqual(['retire_superseded_work_item']);
    // and no TypeScript source other than recordStage writes work_items.stage
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === 'test' || e.name === 'dist' || e.name === '.next') continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && /UPDATE\s+work_items\s+SET[^`'"]*\bstage\s*=/i.test(readFileSync(p, 'utf8'))) hits.push(relative(root, p));
      }
    };
    for (const top of ['packages', 'apps']) for (const e of readdirSync(join(root, top), { withFileTypes: true })) if (e.isDirectory()) walk(join(root, top, e.name));
    expect(hits).toEqual(['packages/core/src/work-items/recordStage.ts']);
  });
});
