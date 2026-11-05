import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CATALOGUE_VERSION } from '@fx/decisions';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { writePlanWritebackMergeFact, writePlanWritebackReceipt } from '../src/receiptWriter.js';
import { recordWritebackReceiptOn } from '../src/mergeReceipt.js';
import { listPlanWritebackMerges } from '../src/planWritebackSettings.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

/**
 * [pg] migration 0988: plan_writeback_receipt_write, the one function the app login calls to leave the receipt behind a plan update the merge queue's gate merged.
 * Everything goes through the real logins (app_user, platform_ops) and the real definer; the queue entry is written as the tick writes it.
 */
const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);

describe('migration 0988: plan_writeback_receipt_write [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let opsPool: Pool;
  let A: SeedRefs;
  let B: SeedRefs;
  let wb: string;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, appPool, opsPool]) await p.end();
  });
  beforeEach(async () => {
    A = await seedAccount(admin, randomUUID());
    B = await seedAccount(admin, randomUUID());
    wb = randomUUID();
    await admin.query(
      `INSERT INTO plan_writebacks (id, account_id, repo_id, state, plan_path, branch, pr_number, head_sha, base_sha) VALUES ($1, $2, $3, 'open', 'plan.json', 'fulcrumaxe/plan-update-x', 9, $4, $5)`,
      [wb, A.accountId, A.repoId, HEAD, 'c'.repeat(40)],
    );
  });

  const entry = (state: 'merged' | 'queued', mergedBy: 'gate' | 'person' | null) =>
    admin.query(
      `INSERT INTO merge_queue_entries (account_id, repo_id, entry_kind, plan_writeback_id, pr_number, head_sha, approved_at, state, merged_by) VALUES ($1, $2, 'plan_writeback', $3, 9, $4, now(), $5, $6)`,
      [A.accountId, A.repoId, wb, HEAD, state, mergedBy],
    );
  /** The gate's own fact, as the gate writes it straight after its merge call. */
  const fact = (head = HEAD, chosen = 'act', dialVersion = 0) =>
    admin.query(`INSERT INTO plan_writeback_merges (account_id, plan_writeback_id, head_sha, chosen, dial_version) VALUES ($1, $2, $3, $4, $5)`, [A.accountId, wb, head, chosen, dialVersion]);
  const dial = (disposition: string, version: number, preset: string | null = null) =>
    admin.query(`INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, preset, version, changed_by) VALUES ($1, $2, 'merge_after_reviews', $3, $4, $5, $6)`, [A.accountId, A.repoId, disposition, preset, version, A.userId]);
  const call = (client: PoolClient, args: { chosen?: string; dialVersion?: number; head?: string; id?: string } = {}) =>
    client.query<{ o_id: string; o_replayed: boolean }>('SELECT * FROM plan_writeback_receipt_write($1, $2, $3, $4, $5)', [args.id ?? wb, args.head ?? HEAD, args.chosen ?? 'act', args.dialVersion ?? 0, CATALOGUE_VERSION]);
  const asApp = <T>(fn: (c: PoolClient) => Promise<T>, accountId = A.accountId): Promise<T> => withTenant(appPool, accountId, fn);
  const refuse = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return (e as { code?: string }).code;
    }
    return 'no error';
  };
  const receipts = async () => (await admin.query(`SELECT * FROM decision_receipts WHERE account_id = $1 AND decision_type = 'merge_after_reviews'`, [A.accountId])).rows;

  it('writes one class 2 receipt for a write-back the gate merged: policy actor, no work item, no run, the dial version, tied to the write-back', async () => {
    await fact();
    const out = await asApp((c) => call(c));
    expect(out.rows[0]!.o_replayed).toBe(false);
    const rows = await receipts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: out.rows[0]!.o_id, class: 'human_over_the_loop', chosen: 'act', rejected_alternative: 'ask', dial_version: 0, actor: 'policy', run_id: null, work_item_id: null, catalogue_version: CATALOGUE_VERSION, reversal_free_until: null });
    const merges = await asApp((c) => listPlanWritebackMerges(c, A.repoId));
    expect(merges).toMatchObject([{ id: out.rows[0]!.o_id, chosen: 'act' }]);
    // Another account reads nothing of it.
    expect(await asApp((c) => listPlanWritebackMerges(c, A.repoId), B.accountId)).toEqual([]);
  });

  it('refuses a merge the gate recorded no fact of: no fact (a queue entry the gate merged is not enough), a call at another head, a fact at another head, a fact that says something else', async () => {
    expect(await refuse(asApp((c) => call(c)))).toBe('P0002');
    await entry('merged', 'gate');
    expect(await refuse(asApp((c) => call(c)))).toBe('P0002');
    await fact();
    expect(await refuse(asApp((c) => call(c, { head: OTHER_HEAD })))).toBe('P0002');
    expect(await refuse(asApp((c) => call(c, { chosen: 'announce', dialVersion: 0 })))).toBe('22023');
    expect(await receipts()).toHaveLength(0);
    // A fact at a head that is not the write-back's recorded one.
    await admin.query(`DELETE FROM plan_writeback_merges WHERE plan_writeback_id = $1`, [wb]);
    await fact(OTHER_HEAD);
    expect(await refuse(asApp((c) => call(c)))).toBe('P0002');
    expect(await refuse(asApp((c) => call(c, { head: OTHER_HEAD })))).toBe('P0002');
    expect(await receipts()).toHaveLength(0);
  });

  it('the race: the entry settled as a person\'s merge (the webhook or the reconcile got there first) still gets its receipt, because the receipt keys on the gate\'s fact; a hand merge with no fact gets none', async () => {
    await entry('merged', 'person');
    expect(await refuse(asApp((c) => call(c)))).toBe('P0002'); // a person's merge, no fact: nothing
    await fact();
    const out = await asApp((c) => call(c));
    expect(out.rows[0]!.o_replayed).toBe(false);
    expect(await receipts()).toHaveLength(1);
  });

  it('the gate\'s fact: written once as the app login (the second write changes nothing), readable only by its own account, never updated or deleted by the app login', async () => {
    const input = { planWritebackId: wb, headSha: HEAD, chosen: 'announce' as const, dialVersion: 2 };
    expect(await asApp((c) => writePlanWritebackMergeFact(c, input))).toBe(true);
    expect(await asApp((c) => writePlanWritebackMergeFact(c, { ...input, chosen: 'act' }))).toBe(false);
    expect((await admin.query(`SELECT chosen, dial_version FROM plan_writeback_merges WHERE plan_writeback_id = $1`, [wb])).rows).toEqual([{ chosen: 'announce', dial_version: 2 }]);
    expect((await asApp((c) => c.query(`SELECT 1 FROM plan_writeback_merges`), B.accountId)).rowCount).toBe(0);
    expect(await refuse(asApp((c) => c.query(`UPDATE plan_writeback_merges SET chosen = 'act'`)))).toBe('42501');
    expect(await refuse(asApp((c) => c.query(`DELETE FROM plan_writeback_merges`)))).toBe('42501');
    // Another account can not write a fact for this write-back, and a bad word is refused before any query.
    expect(await refuse(asApp((c) => writePlanWritebackMergeFact(c, input), B.accountId))).toBe('23503');
    await expect(asApp((c) => writePlanWritebackMergeFact(c, { ...input, chosen: 'ask' as never }))).rejects.toMatchObject({ code: 'receipt_chosen_invalid' });
  });

  it('refuses a person or a token session, platform_ops, a bad argument, and another account', async () => {
    await fact();
    expect(await refuse(withTenant(appPool, A.accountId, A.userId, (c) => call(c)))).toBe('42501');
    expect(await refuse(withTenant(opsPool, A.accountId, (c) => call(c)))).toBe('42501');
    expect(await refuse(asApp((c) => call(c, { head: 'zz' })))).toBe('22023');
    expect(await refuse(asApp((c) => call(c, { chosen: 'ask' })))).toBe('22023');
    expect(await refuse(asApp((c) => call(c), B.accountId))).toBe('P0002');
    expect(await receipts()).toHaveLength(0);
  });

  it('what the receipt names must be what the dial said at that version', async () => {
    const refact = async (chosen: string, dialVersion: number) => {
      await admin.query(`DELETE FROM plan_writeback_merges WHERE plan_writeback_id = $1`, [wb]);
      await fact(HEAD, chosen, dialVersion);
    };
    await refact('act', 4);
    expect(await refuse(asApp((c) => call(c, { dialVersion: 4 })))).toBe('22023'); // no such version
    await dial('ask', 1, 'cautious');
    await refact('act', 1);
    expect(await refuse(asApp((c) => call(c, { dialVersion: 1 })))).toBe('22023'); // the dial said ask, not act
    await dial('announce', 2, 'balanced');
    await refact('act', 2);
    expect(await refuse(asApp((c) => call(c, { dialVersion: 2, chosen: 'act' })))).toBe('22023');
    await dial('act', 3, 'default');
    await refact('act', 3);
    expect((await asApp((c) => call(c, { dialVersion: 3, chosen: 'act' }))).rows[0]!.o_replayed).toBe(false);
  });

  it('a replay and eight concurrent calls leave one receipt; the app login can not insert the link or a receipt itself', async () => {
    await fact();
    const first = await asApp((c) => call(c));
    const raced = await Promise.all(Array.from({ length: 8 }, () => asApp((c) => call(c))));
    expect(new Set(raced.map((r) => r.rows[0]!.o_id))).toEqual(new Set([first.rows[0]!.o_id]));
    expect(await receipts()).toHaveLength(1);
    expect(await refuse(asApp((c) => c.query(`INSERT INTO plan_writeback_receipts (account_id, plan_writeback_id, receipt_id) VALUES ($1, $2, $3)`, [A.accountId, wb, first.rows[0]!.o_id])))).toBe('42501');
  });

  it('the TypeScript recorder: written, replayed, and a failure rolls back only itself and is reported as failed', async () => {
    await fact();
    const rec = (head = HEAD, disposition: 'act' | 'announce' | 'ask' = 'act') => asApp((c) => recordWritebackReceiptOn(c, { planWritebackId: wb, headSha: head, dial: { disposition, version: 0 } }));
    expect(await rec(OTHER_HEAD)).toBe('failed');
    expect(await rec(HEAD, 'ask')).toBe('failed');
    expect(await receipts()).toHaveLength(0);
    expect(await rec()).toBe('written');
    expect(await rec()).toBe('replayed');
    await expect(asApp((c) => writePlanWritebackReceipt(c, { planWritebackId: wb, headSha: 'bad', chosen: 'act', dialVersion: 0 }))).rejects.toMatchObject({ code: 'receipt_chosen_invalid' });
  });
});
