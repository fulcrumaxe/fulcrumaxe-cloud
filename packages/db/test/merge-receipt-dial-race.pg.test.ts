import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { readMergeDial, readMergeDialVersion } from '../src/mergeDial.js';
import { recordMergeReceiptOn } from '../src/mergeReceipt.js';
import { insertRunner } from './helpers/runnerFixtures.js';
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
  async function race(late: 'announce' | 'ask', gateWrites: 'read_version' | 'nothing' | 'webhook_first' | 'gate_first' | 'manual_enqueue'): Promise<void> {
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
    } else if (gateWrites === 'gate_first') {
      // The gate's own facts in its transaction came first; the webhook's enqueue for the same head is the no-op (same key).
      await fact('merge_gate', read.version, 'merge_enqueued');
      await fact('merge_enqueued', read.version);
    } else if (gateWrites === 'nothing') {
      // Written before migration 0990: the gate's facts exist and name no version.
      await fact('merge_gate', null, 'merge_enqueued');
      await fact('merge_enqueued', null);
    } else if (gateWrites === 'read_version') {
      await fact('merge_enqueued', read.version);
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

  it('gate facts with no version (written before the column) keep the time-based read, which is the version that races ahead', async () => {
    await race('announce', 'nothing');
    expect(await receipt()).toBe('written');
    expect(await receipts()).toEqual([{ chosen: 'announce', dial_version: 2 }]);
  });

  it('the webhook wrote the enqueue fact first (no version): the receipt falls back to the version on the gate\'s own merge_gate fact at that head', async () => {
    await race('announce', 'webhook_first');
    expect(await receipt()).toBe('written');
    expect(await receipts()).toEqual([{ chosen: 'act', dial_version: 1 }]);
  });

  it('an enqueue nobody\'s gate decided (a person pressed Merge when ready: only the webhook\'s fact, no merge_gate fact) is not a policy merge: no receipt, nothing reported', async () => {
    await race('announce', 'manual_enqueue');
    expect(await receipt()).toBe('not_policy');
    expect(await receipts()).toEqual([]);
  });

  it('the gate enqueued first, then the webhook\'s delivery: the receipt names the version the gate read', async () => {
    await race('announce', 'gate_first');
    expect(await receipt()).toBe('written');
    expect(await receipts()).toEqual([{ chosen: 'act', dial_version: 1 }]);
  });

  it('a manual enqueue of a head the gate had put in the queue earlier and a person took out is still no policy merge (the removal rule holds)', async () => {
    await dialRow(admin, 'act', 1);
    await fact('merge_gate', 1, 'merge_enqueued');
    await fact('merge_enqueued', 1);
    await admin.query(`INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, head_sha, pr_number, dedupe_key) VALUES ($1, $2, 'merge_dequeued', 'user', $3, 7, $4)`, [A.accountId, A.workItemId, HEAD, `d:${randomUUID()}`]);
    await fact('merged_via_queue');
    expect(await receipt()).toBe('not_policy');
    expect(await receipts()).toEqual([]);
  });

  const removal = (head: string, code: string) =>
    admin.query(`INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, head_sha, pr_number, dedupe_key) VALUES ($1, $2, 'merge_dequeued', $3, $4, 7, $5)`, [A.accountId, A.workItemId, code, head, `d:${randomUUID()}`]);

  describe('gate evidence from before a removal says nothing about a later enqueue', () => {
    it('a person re-queued by hand after the queue removed the gate\'s entry, before the gate retried: the old gate fact does not count, no policy receipt', async () => {
      await dialRow(admin, 'act', 1);
      await fact('merge_gate', 1, 'merge_enqueued');
      await fact('merge_enqueued', 1);
      await removal(HEAD, 'checks_failed');
      await fact('merge_enqueued', null); // the hand re-queue as the reconcile or webhook writes it: no version
      await fact('merged_via_queue');
      expect(await receipt()).toBe('not_policy');
      expect(await receipts()).toEqual([]);
    });

    it('the gate retried after the removal: its new fact is evidence and the merge is receipted at the version it read', async () => {
      await dialRow(admin, 'act', 1);
      await fact('merge_gate', 1, 'merge_enqueued');
      await fact('merge_enqueued', 1);
      await removal(HEAD, 'checks_failed');
      await dialRow(admin, 'announce', 2);
      // Production dedupes a second merge_gate fact at this head (key `<head>:merge_enqueued`), so only the gate's versioned r1 enqueue follows the removal.
      await fact('merge_enqueued', 2);
      await fact('merged_via_queue');
      expect(await receipt()).toBe('written');
      expect(await receipts()).toEqual([{ chosen: 'announce', dial_version: 2 }]);
    });

    it('a removal that is the host\'s own success reason is not a removal: the gate fact from before it still counts', async () => {
      await dialRow(admin, 'act', 1);
      await fact('merge_gate', 1, 'merge_enqueued');
      await fact('merge_enqueued', 1);
      await removal(HEAD, 'merge');
      await fact('merged_via_queue');
      expect(await receipt()).toBe('written');
      expect(await receipts()).toEqual([{ chosen: 'act', dial_version: 1 }]);
    });

    it('a removal at another head does not discard the gate fact at this one', async () => {
      await dialRow(admin, 'act', 1);
      await fact('merge_gate', 1, 'merge_enqueued');
      await fact('merge_enqueued', 1);
      await removal('c'.repeat(40), 'user');
      await fact('merged_via_queue');
      expect(await receipt()).toBe('written');
    });

    it('a merge_gate fact that is not an enqueue (ready_human_merges) is not evidence of the gate\'s enqueue', async () => {
      await dialRow(admin, 'act', 1);
      await fact('merge_gate', 1, 'ready_human_merges');
      await fact('merge_enqueued', null);
      await fact('merged_via_queue');
      expect(await receipt()).toBe('not_policy');
      expect(await receipts()).toEqual([]);
    });
  });

  describe('a paired item: the public pull request is queued by a runner on an order, and the gate\'s fact is keyed on the reviewed head', () => {
    const PUBLIC = 'b'.repeat(40);
    async function order(state: 'enqueued' | 'merged' | 'failed'): Promise<void> {
      const push = randomUUID();
      await admin.query("INSERT INTO plane_pushes (id, account_id, work_item_id, repo_id, code_repo, pairing_digest, state) VALUES ($1, $2, $3, $4, 'acme/widgets-public', $5, 'building')", [push, A.accountId, A.workItemId, A.repoId, 'a'.repeat(64)]);
      await admin.query(
        `INSERT INTO plane_merge_orders (account_id, work_item_id, plane_push_id, repo_id, code_repo, pr_number, expected_public_head, reviewed_head, pairing_digest, deadline_at)
         VALUES ($1, $2, $3, $4, 'acme/widgets-public', 7, $5, $6, $7, now() + interval '1 hour')`,
        [A.accountId, A.workItemId, push, A.repoId, PUBLIC, HEAD, 'a'.repeat(64)],
      );
      const runner = await insertRunner(admin, A.accountId, A.userId);
      const upd = (set: string) => admin.query(`UPDATE plane_merge_orders SET ${set} WHERE work_item_id = $1`, [A.workItemId]);
      await upd(`state = 'claimed', runner_id = '${runner}', lease_generation = 1, attempts = 1, lease_expires_at = now() + interval '10 minutes'`);
      if (state === 'enqueued' || state === 'merged') {
        await upd(`state = 'authorized', write_token_issued_at = now()`);
        await upd(`state = '${state}', outcome_code = '${state}', finished_at = now()`);
      } else {
        await upd(`state = 'failed', outcome_code = 'runner_report_mismatch', finished_at = now()`);
      }
    }
    const publicFact = (kind: string, code = 'queue') =>
      admin.query(`INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, head_sha, pr_number, dedupe_key) VALUES ($1, $2, $3, $4, $5, 7, $6)`, [A.accountId, A.workItemId, kind, code, PUBLIC, `${kind}:${randomUUID()}`]);
    const pairedReceipt = () => asApp((c) => recordMergeReceiptOn(c, { accountId: A.accountId, workItemId: A.workItemId, eventHead: PUBLIC, reviewHeads: [PUBLIC, HEAD], outcome: 'merged', decidedBy: { kind: 'merge_enqueued', head: PUBLIC } }));

    it('the webhook wrote the public enqueue fact before the runner\'s report: the receipt names the version on the gate\'s merge_delegated fact at the reviewed head', async () => {
      await dialRow(admin, 'act', 1);
      await racer.query('BEGIN');
      await dialRow(racer, 'announce', 2);
      await fact('merge_gate', 1, 'merge_delegated');
      await order('enqueued');
      await publicFact('merge_enqueued');
      await racer.query('COMMIT');
      await publicFact('merged_via_queue');
      expect(await pairedReceipt()).toBe('written');
      expect(await receipts()).toEqual([{ chosen: 'act', dial_version: 1 }]);
    });

    it('a public pull request a person queued by hand, with an order that failed or none at all: no policy receipt', async () => {
      await dialRow(admin, 'act', 1);
      await fact('merge_gate', 1, 'merge_delegated');
      await order('failed');
      await publicFact('merge_enqueued');
      await publicFact('merged_via_queue');
      expect(await pairedReceipt()).toBe('not_policy');
      expect(await receipts()).toEqual([]);
    });

    it('a hand re-queue after a removal of the public pull request: the delegated fact from before the removal does not count', async () => {
      await dialRow(admin, 'act', 1);
      await fact('merge_gate', 1, 'merge_delegated');
      await order('enqueued');
      await publicFact('merge_enqueued');
      await removal(PUBLIC, 'user');
      await publicFact('merge_enqueued');
      await publicFact('merged_via_queue');
      expect(await pairedReceipt()).toBe('not_policy');
      expect(await receipts()).toEqual([]);
    });

    it('the gate delegated again after the removal: the new delegated fact counts', async () => {
      await dialRow(admin, 'act', 1);
      await fact('merge_gate', 1, 'merge_delegated');
      await order('enqueued');
      await publicFact('merge_enqueued');
      await removal(PUBLIC, 'user');
      await fact('merge_gate', 1, 'merge_delegated');
      await publicFact('merge_enqueued');
      await publicFact('merged_via_queue');
      expect(await pairedReceipt()).toBe('written');
    });

    it('a merge_gate ready_human_merges fact at the reviewed head is not a delegated fact', async () => {
      await dialRow(admin, 'act', 1);
      await fact('merge_gate', 1, 'ready_human_merges');
      await order('enqueued');
      await publicFact('merge_enqueued');
      await publicFact('merged_via_queue');
      expect(await pairedReceipt()).toBe('not_policy');
    });

    it('an order that ended enqueued but whose reviewed head has no delegated gate fact is not evidence', async () => {
      await dialRow(admin, 'act', 1);
      await order('enqueued');
      await publicFact('merge_enqueued');
      await publicFact('merged_via_queue');
      expect(await pairedReceipt()).toBe('not_policy');
    });
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
