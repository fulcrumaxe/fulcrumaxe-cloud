import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { writeReceipt, writeReversalReceipt } from '../src/receiptWriter.js';
import { claimCompensation, finishCompensation, insertCompensation, listDueCompensations, retryCompensation } from '../src/reversalCompensation.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * [pg] D#7 DP7-2g, migration 0945: a person's retry of a failed compensation, on the same row. Only a failed re-run or revert row the tick will not take
 * goes back to `pending`; the reason and attempts are cleared; no receipt is written; the audit row is written with the move. "As the invoker" is a LOGIN
 * that is a member of app_user and receipt_writer_invoker.
 */
const LOGIN = 'fx_reversal_retry_test';

describe('reversal_compensation_retry (0945) [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let opsPool: Pool;
  let invokerPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${LOGIN}') THEN
      CREATE ROLE ${LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$`);
    await admin.query(`GRANT app_user, receipt_writer_invoker TO ${LOGIN}`);
    const u = new URL(process.env.DATABASE_URL_APP_USER!);
    u.username = LOGIN;
    u.password = '';
    invokerPool = createPool(u.toString());
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end(), opsPool.end(), invokerPool.end()]);
  });

  /** A compensation row (and its reversal receipt) for the account, then forced to the given state with the admin login. */
  async function row(t: SeedRefs, over: { kind?: 'rerun' | 'revert_pr' | 'refused' | 'unavailable'; state?: string; reason?: string | null; attempts?: number } = {}): Promise<{ id: string; receiptId: string }> {
    const workItemId = (await admin.query<{ id: string }>(`INSERT INTO work_items (account_id, repo_id, kind, provenance, title) VALUES ($1, $2, 'issue', 'internal', 'Fix it') RETURNING id`, [t.accountId, t.repoId])).rows[0]!.id;
    const runId = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'reviewer', 'local', 'succeeded')`, [runId, t.accountId, workItemId]);
    const o = await withTenant(invokerPool, t.accountId, t.userId, (c) =>
      writeReceipt(c, { class: 'human_over_the_loop', runId, workItemId, decisionType: 'test_strategy_choice', chosen: 'unit_tests', rejectedAlternative: 'end_to_end_tests', dialVersion: 0, quotedInputs: [] }));
    if (o.store !== 'decision_receipts') throw new Error('expected the durable store');
    const r = await withTenant(invokerPool, t.accountId, t.userId, (c) => writeReversalReceipt(c, { reversesReceiptId: o.id, runId, chosen: 'reversed', rejectedAlternative: 'reverse_refused', dialVersion: 0 }));
    const kind = over.kind ?? 'revert_pr';
    const refused = kind === 'refused' || kind === 'unavailable';
    const id = (await withTenant(invokerPool, t.accountId, t.userId, (c) =>
      insertCompensation(c, { reversalReceiptId: r.id, kind, state: refused ? 'failed' : 'pending', reasonCode: refused ? 'not_reversible' : null }))).id;
    if (!refused) {
      await admin.query('UPDATE reversal_compensations SET state = $2, reason_code = $3, attempts = $4 WHERE id = $1', [id, over.state ?? 'failed', over.reason === undefined ? 'repo_gone' : over.reason, over.attempts ?? 1]);
    }
    return { id, receiptId: r.id };
  }
  const retry = (t: SeedRefs, id: string) => withTenant(invokerPool, t.accountId, t.userId, (c) => retryCompensation(c, id));
  const stateOf = async (id: string) => (await admin.query('SELECT state, reason_code, attempts, kind, reversal_receipt_id FROM reversal_compensations WHERE id = $1', [id])).rows[0];
  const audits = async (accountId: string) => (await admin.query("SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'reversal.retried'", [accountId])).rows;
  const receiptCount = async (accountId: string) => Number((await admin.query('SELECT count(*) AS n FROM decision_receipts WHERE account_id = $1', [accountId])).rows[0].n);

  it('owner platform_ops, pinned search_path, EXECUTE for the invoker only; a platform_ops login, the app role and a call with no tenant are refused', async () => {
    const r = (await admin.query(
      `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, p.proconfig AS config,
              EXISTS (SELECT 1 FROM aclexplode(p.proacl) x WHERE x.grantee = 0) AS public_grant,
              (SELECT array_agg(DISTINCT pg_get_userbyid(x.grantee)::text) FROM aclexplode(p.proacl) x WHERE x.grantee <> p.proowner) AS grantees
         FROM pg_proc p WHERE p.oid = 'reversal_compensation_retry(uuid)'::regprocedure`)).rows[0];
    expect(r).toEqual({ owner: 'platform_ops', definer: true, config: ['search_path=pg_catalog, public, pg_temp'], public_grant: false, grantees: ['receipt_writer_invoker'] });
    const id = randomUUID();
    await expect(opsPool.query('SELECT * FROM reversal_compensation_retry($1)', [id])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    await expect(appPool.query('SELECT * FROM reversal_compensation_retry($1)', [id])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    await expect(invokerPool.query('SELECT * FROM reversal_compensation_retry($1)', [id])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
  });

  it.each([
    ['revert_pr', 'repo_gone', 1],
    ['rerun', 'no_installation', 2],
    ['rerun', 'revert_refused', 1],
    ['revert_pr', 'tooling_error', 3],
  ] as const)('moves a failed %s row (%s, %i attempts) back to pending on the same row: reason and attempts cleared, no receipt, one audit row', async (kind, reason, attempts) => {
    const t = await seedAccount(admin, randomUUID());
    const { id, receiptId } = await row(t, { kind, reason, attempts });
    const receipts = await receiptCount(t.accountId);
    expect(await retry(t, id)).toEqual({ found: true, moved: true, state: 'pending', kind });
    expect(await stateOf(id)).toMatchObject({ state: 'pending', reason_code: null, attempts: 0, reversal_receipt_id: receiptId });
    expect(await receiptCount(t.accountId)).toBe(receipts);
    const a = await audits(t.accountId);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ actor: t.userId, payload: { reversal_id: id, kind, previous_reason: reason } });
    // The next tick lists it and the claim takes it, as for any pending row.
    expect(await listDueCompensations(invokerPool, 100)).toContain(id);
    expect(await claimCompensation(invokerPool, id)).toMatchObject({ id, attempts: 1 });
  });

  it('fails, retries, fails again with a new reason, retries again, and succeeds, all on one row', async () => {
    const t = await seedAccount(admin, randomUUID());
    const { id } = await row(t, { state: 'pending', reason: null, attempts: 0 });
    expect(await claimCompensation(invokerPool, id)).toMatchObject({ id });
    expect(await finishCompensation(invokerPool, id, { state: 'failed', reasonCode: 'repo_gone' })).toBe(true);
    expect((await retry(t, id)).moved).toBe(true);
    expect(await claimCompensation(invokerPool, id)).toMatchObject({ id, attempts: 1 });
    expect(await finishCompensation(invokerPool, id, { state: 'failed', reasonCode: 'no_installation' })).toBe(true);
    expect(await stateOf(id)).toMatchObject({ state: 'failed', reason_code: 'no_installation' });
    expect((await retry(t, id)).moved).toBe(true);
    expect(await claimCompensation(invokerPool, id)).toMatchObject({ id });
    expect(await finishCompensation(invokerPool, id, { state: 'done', prNumber: 7 })).toBe(true);
    expect(await stateOf(id)).toMatchObject({ state: 'done', reason_code: null });
    expect(await audits(t.accountId)).toHaveLength(2);
  });

  it('changes nothing for a row the tick owns or that is never retried, and says what it is', async () => {
    const t = await seedAccount(admin, randomUUID());
    const cases: Array<[Parameters<typeof row>[1], string]> = [
      [{ state: 'pending', reason: null, attempts: 0 }, 'pending'],
      [{ state: 'running', reason: null, attempts: 1 }, 'running'],
      [{ state: 'done', reason: null, attempts: 1 }, 'done'],
      [{ state: 'awaiting_confirm', reason: null, attempts: 0 }, 'awaiting_confirm'],
      [{ state: 'failed', reason: 'tooling_error', attempts: 2 }, 'failed'],
      [{ kind: 'refused' }, 'failed'],
      [{ kind: 'unavailable' }, 'failed'],
    ];
    for (const [over, state] of cases) {
      const { id } = await row(t, over);
      const before = await stateOf(id);
      const out = await retry(t, id);
      expect(out).toMatchObject({ found: true, moved: false, state });
      expect(await stateOf(id)).toEqual(before);
    }
    expect(await audits(t.accountId)).toHaveLength(0);
  });

  it("answers not found for another account's row; a plain member, an inactive account and a missing id are refused", async () => {
    const a = await seedAccount(admin, randomUUID());
    const b = await seedAccount(admin, randomUUID());
    const { id } = await row(a);
    expect(await retry(b, id)).toEqual({ found: false, moved: false, state: null, kind: null });
    expect((await stateOf(id)).state).toBe('failed');

    const memberId = randomUUID();
    await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [memberId, `${memberId}@example.test`]);
    await admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')", [a.accountId, memberId]);
    await expect(withTenant(invokerPool, a.accountId, memberId, (c) => retryCompensation(c, id))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    expect((await stateOf(id)).state).toBe('failed');

    await expect(withTenant(invokerPool, a.accountId, a.userId, (c) => c.query('SELECT * FROM reversal_compensation_retry(NULL)'))).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
    await admin.query('UPDATE accounts SET deleted_at = now() WHERE id = $1', [a.accountId]);
    await expect(retry(a, id)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    await admin.query('UPDATE accounts SET deleted_at = NULL WHERE id = $1', [a.accountId]);
    expect((await stateOf(id)).state).toBe('failed');
    expect(await audits(a.accountId)).toHaveLength(0);
  });
});
