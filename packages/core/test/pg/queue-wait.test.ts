import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { withTenant } from '../../src/tenancy/withTenant.js';
import { recordDriverEvent } from '../../src/work-items/driverEvents.js';
import { readQueueWait } from '../../src/work-items/mergeReadiness.js';

/** D#519 MQ5-c1: the activity response's `queue_wait`, read from real rows through the app role. Derived on each read, never stored. */
describe('readQueueWait', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;
  const head = 'a'.repeat(40);

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
  });
  beforeEach(async () => {
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
  });

  // The same counting the route passes in (`mergeQueue.countAhead`): entries of the same account and repository in front of this one.
  const countAhead = async (c: Pick<PoolClient, 'query'>, accountId: string, entryId: string) =>
    (
      await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM merge_queue_entries me JOIN merge_queue_entries o ON o.account_id = me.account_id AND o.repo_id = me.repo_id AND o.id <> me.id
          WHERE me.account_id = $1 AND me.id = $2 AND (o.state = 'in_flight' OR (o.state IN ('queued', 'awaiting_work') AND (o.approved_at, o.pr_number) < (me.approved_at, me.pr_number)))`,
        [accountId, entryId],
      )
    ).rows[0]!.n;
  const read = (r: SeedRefs, asAccount = r.accountId) => withTenant(appUserPool, asAccount, (c) => readQueueWait(c, asAccount, r.workItemId, countAhead));
  const otherItem = async (r: SeedRefs) => (await admin.query<{ id: string }>(`INSERT INTO work_items (account_id, repo_id, kind, provenance) VALUES ($1, $2, 'bug', 'internal') RETURNING id`, [r.accountId, r.repoId])).rows[0]!.id;
  const entry = async (r: SeedRefs, state: string, o: { pr?: number; at?: string; reason?: string; other?: boolean; parent?: number } = {}) =>
    admin.query(
      `INSERT INTO merge_queue_entries (account_id, repo_id, work_item_id, pr_number, head_sha, approved_at, state, reason, depends_on_pr_number)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9)`,
      [r.accountId, r.repoId, o.other === true ? await otherItem(r) : r.workItemId, o.pr ?? 7, head, o.at ?? '2026-01-02T00:00:00Z', state, o.reason ?? null, o.parent ?? null],
    );
  const stopFact = (r: SeedRefs, code: string, reasons: string[], baseRef?: string) =>
    withTenant(appUserPool, r.accountId, (c) =>
      recordDriverEvent(c, r.accountId, { workItemId: r.workItemId, kind: 'stopped', dedupeKey: `qw:${code}`, code, reasons, headSha: head, prNumber: 7, round: 0, ...(baseRef ? { detail: { baseRef } } : {}) }),
    );

  it('MQ5-c1-5: absent without an entry and for an entry in any other state', async () => {
    expect(await read(a)).toBeNull();
    await entry(a, 'in_review');
    expect(await read(a)).toBeNull();
  });

  it('MQ5-c1-5: a waiting entry carries the count ahead, and the count follows the queue', async () => {
    await entry(a, 'queued', { pr: 9, at: '2026-01-03T00:00:00Z' });
    await entry(a, 'queued', { pr: 3, at: '2026-01-01T00:00:00Z', other: true });
    expect(await read(a)).toEqual({ ahead: 1 });
    await admin.query(`UPDATE merge_queue_entries SET state = 'stopped', reason = 'branch_behind' WHERE account_id = $1 AND pr_number = 3`, [a.accountId]);
    expect(await read(a)).toEqual({ ahead: 0 });
  });

  it('MQ5-c1-5: a stop with a field-filled code carries only the fields it records', async () => {
    await entry(a, 'stopped', { reason: 'ordered_resource_out_of_order' });
    await stopFact(a, 'ordered_resource_out_of_order', ['resource_migrations', 'key_0710', 'highest_0712', 'branch_main']);
    expect(await read(a)).toEqual({ branch: 'main', resource: 'migrations', key: '0710', main_key: '0712' });
  });

  it('a token that does not parse is left out, and a stop with no fact answers an empty object', async () => {
    await entry(a, 'stopped', { reason: 'ordered_resource_out_of_order' });
    expect(await read(a)).toEqual({});
    await stopFact(a, 'ordered_resource_out_of_order', ['resource_', 'key_', 'highest_0712', 'branch_main']);
    expect(await read(a)).toEqual({ branch: 'main', main_key: '0712' });
  });

  it('branch_behind takes its branch from the detail row; merge_dependency_closed answers the parent number', async () => {
    await entry(a, 'stopped', { reason: 'branch_behind' });
    await stopFact(a, 'branch_behind', [], 'release/1.x');
    expect(await read(a)).toEqual({ branch: 'release/1.x' });
    await entry(b, 'stopped', { reason: 'merge_dependency_closed', parent: 41 });
    expect(await read(b)).toEqual({ parent_pr: 41 });
  });

  it('a stop with any other code is not told', async () => {
    await entry(a, 'stopped', { reason: 'merge_conflict' });
    expect(await read(a)).toBeNull();
  });

  it('MQ5-c1-6: two accounts with queued entries each count only their own, and a caller of the other account gets nothing', async () => {
    await entry(a, 'queued', { pr: 9, at: '2026-01-03T00:00:00Z' });
    await entry(a, 'queued', { pr: 3, at: '2026-01-01T00:00:00Z', other: true });
    await entry(b, 'queued', { pr: 9, at: '2026-01-03T00:00:00Z' });
    expect(await read(a)).toEqual({ ahead: 1 });
    expect(await read(b)).toEqual({ ahead: 0 });
    expect(await read(a, b.accountId)).toBeNull();
  });
});
