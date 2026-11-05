import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { readMergeDial, readMergeDialVersion } from '../src/mergeDial.js';
import { recordMergeReceiptOn } from '../src/mergeReceipt.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

/**
 * [pg] D#7 DW-R4 (migration 0990): the receipt for a merge the host queue made names the dial version the gate READ when it enqueued, not the newest version created
 * at or before the enqueue fact's time. The race: a dial row written by a transaction that started before the decision (so its created_at is earlier) and committed
 * after it. Two real transactions; the dial row commits after the gate has read and written its fact.
 */
const HEAD = 'a'.repeat(40);

describe('merge receipt names the dial the gate read, not a version that committed after the decision [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let racer: PoolClient;
  let appPool: Pool;
  let A: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    racer = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
  });
  afterAll(async () => {
    admin.release();
    racer.release();
    for (const p of [adminPool, appPool]) await p.end();
  });
  beforeEach(async () => {
    A = await seedAccount(admin, randomUUID());
    await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status, work_item_id, head_sha) VALUES ($1, $2, 'code-reviewer', 'production', 'succeeded', $3, $4)`, [randomUUID(), A.accountId, A.workItemId, HEAD]);
  });

  const dialRow = (c: PoolClient, disposition: string, version: number) =>
    c.query(`INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, preset, version, changed_by) VALUES ($1, $2, 'merge_after_reviews', $3, NULL, $4, $5)`, [A.accountId, A.repoId, disposition, version, A.userId]);
  const fact = (kind: string, dialVersion: number | null = null, code = 'queue') =>
    admin.query(`INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, head_sha, pr_number, dedupe_key, dial_version) VALUES ($1, $2, $3, $4, $5, 7, $6, $7)`, [A.accountId, A.workItemId, kind, code, HEAD, `${kind}:${randomUUID()}`, dialVersion]);
  const asApp = <T>(fn: (c: PoolClient) => Promise<T>): Promise<T> => withTenant(appPool, A.accountId, fn);
  const receipts = async () => (await admin.query(`SELECT chosen, dial_version FROM decision_receipts WHERE account_id = $1 AND decision_type = 'merge_after_reviews'`, [A.accountId])).rows;
  const receipt = () => asApp((c) => recordMergeReceiptOn(c, { accountId: A.accountId, workItemId: A.workItemId, eventHead: HEAD, reviewHeads: [HEAD], outcome: 'merged', decidedBy: { kind: 'merge_enqueued', head: HEAD } }));

  /** The gate's decision with a dial row (`late`) committing after it. `gateWrites` is what the gate puts on its enqueue fact: the version it read, or none (an older fact). */
  async function race(late: 'announce' | 'ask', gateWrites: 'read_version' | 'nothing' | 'webhook_first' | 'manual_enqueue'): Promise<void> {
    await dialRow(admin, 'act', 1);
    await racer.query('BEGIN');
    await dialRow(racer, late, 2);
    // The gate reads the dial now: the late row is not committed, so it sees version 1 and merges by policy.
    const read = await asApp((c) => readMergeDial(c, A.repoId));
    expect(read).toEqual({ disposition: 'act', version: 1 });
    if (gateWrites === 'webhook_first') {
      // The webhook's enqueue fact (no version) came first and took the key; the gate's own insert was a no-op, but its merge_gate fact names what it read.
      await fact('merge_enqueued', null);
      await fact('merge_gate', read.version, 'merge_enqueued');
    } else if (gateWrites !== 'manual_enqueue') {
      await fact('merge_enqueued', gateWrites === 'read_version' ? read.version : null);
    } else {
      await fact('merge_enqueued', null);
    }
    await racer.query('COMMIT');
    await fact('merged_via_queue');
  }

  it('an announce row that committed after the decision does not rename it: the receipt is act at version 1', async () => {
    await race('announce', 'read_version');
    expect(await receipt()).toBe('written');
    expect(await receipts()).toEqual([{ chosen: 'act', dial_version: 1 }]);
  });

  it('an ask row that committed after the decision does not turn the merge into a missed receipt', async () => {
    await race('ask', 'read_version');
    expect(await receipt()).toBe('written');
    expect(await receipts()).toEqual([{ chosen: 'act', dial_version: 1 }]);
  });

  it('a fact with no version (written before the column) keeps the time-based read, which is the version that races ahead', async () => {
    await race('announce', 'nothing');
    expect(await receipt()).toBe('written');
    expect(await receipts()).toEqual([{ chosen: 'announce', dial_version: 2 }]);
  });

  it('the webhook wrote the enqueue fact first (no version): the receipt falls back to the version on the gate\'s own merge_gate fact at that head', async () => {
    await race('announce', 'webhook_first');
    expect(await receipt()).toBe('written');
    expect(await receipts()).toEqual([{ chosen: 'act', dial_version: 1 }]);
  });

  it('an enqueue nobody\'s gate decided (no merge_gate fact either) stays on the time-based read', async () => {
    await race('announce', 'manual_enqueue');
    expect(await receipt()).toBe('written');
    expect(await receipts()).toEqual([{ chosen: 'announce', dial_version: 2 }]);
  });

  it('the column is for the gate\'s kinds only: any other kind carrying a version is refused by the table', async () => {
    await expect(fact('merged_via_queue', 1)).rejects.toMatchObject({ code: '23514' });
  });

  it('a version no row holds is a reported miss, never a guess', async () => {
    await dialRow(admin, 'act', 1);
    await fact('merge_enqueued', 9);
    await fact('merged_via_queue');
    expect(await receipt()).toBe('failed');
    expect(await receipts()).toEqual([]);
  });

  it('readMergeDialVersion reads exactly the version asked: 0 is the catalogue default, a stored ask stays ask', async () => {
    await dialRow(admin, 'announce', 1);
    await dialRow(admin, 'ask', 2);
    expect(await asApp((c) => readMergeDialVersion(c, A.repoId, 0))).toEqual({ disposition: 'act', version: 0 });
    expect(await asApp((c) => readMergeDialVersion(c, A.repoId, 1))).toEqual({ disposition: 'announce', version: 1 });
    expect(await asApp((c) => readMergeDialVersion(c, A.repoId, 2))).toEqual({ disposition: 'ask', version: 2 });
  });

  it('the column takes a version only as a non-negative integer', async () => {
    await expect(fact('merge_enqueued', -1)).rejects.toMatchObject({ code: '23514' });
  });
});
