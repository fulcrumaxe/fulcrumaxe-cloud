import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { writeReceipt, writeReversalReceipt } from '../src/receiptWriter.js';
import {
  claimCompensation,
  finishCompensation,
  insertCompensation,
  listDueCompensations,
  reversalHoldsClose,
  COMPENSATION_MAX_ATTEMPTS,
  REVERSAL_CLOSE_HOLD_SECONDS,
  type CompensationReason,
} from '../src/reversalCompensation.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * [pg] D#7 DP7-2d, migration 0936: the four reason codes the worker step ends with, the cross-tenant lister it claims from, and the hold that keeps a
 * reversal's own close away from the webhook. "As the invoker" is a LOGIN that is a member of app_user and receipt_writer_invoker.
 */
const LOGIN = 'fx_reversal_due_test';
const ALL_REASONS: CompensationReason[] = [
  'not_reversible', 'irreversible_effect', 'retraction_unavailable', 'revert_refused', 'rerun_refused', 'state_changed', 'head_moved', 'person_managed',
  'cap_allowed', 'tooling_error', 'no_installation', 'repo_gone', 'rerun_would_overwrite_branch', 'no_person_actor',
];

describe('reversal_compensations 0936 [pg]', () => {
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

  /** A pending compensation row of `kind` on a fresh work item (the reversal receipt points at a class 2 receipt). */
  async function row(t: SeedRefs, over: Partial<Parameters<typeof insertCompensation>[1]> = {}): Promise<{ id: string; workItemId: string; receiptId: string }> {
    const workItemId = (await admin.query<{ id: string }>(`INSERT INTO work_items (account_id, repo_id, kind, provenance, title) VALUES ($1, $2, 'issue', 'internal', 'Fix it') RETURNING id`, [t.accountId, t.repoId])).rows[0]!.id;
    const runId = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'reviewer', 'local', 'succeeded')`, [runId, t.accountId, workItemId]);
    const o = await withTenant(invokerPool, t.accountId, t.userId, (c) =>
      writeReceipt(c, { class: 'human_over_the_loop', runId, workItemId, decisionType: 'test_strategy_choice', chosen: 'unit_tests', rejectedAlternative: 'end_to_end_tests', dialVersion: 0, quotedInputs: [] }));
    if (o.store !== 'decision_receipts') throw new Error('expected the durable store');
    const r = await withTenant(invokerPool, t.accountId, t.userId, (c) => writeReversalReceipt(c, { reversesReceiptId: o.id, runId, chosen: 'reversed', rejectedAlternative: 'reverse_refused', dialVersion: 0 }));
    const { id } = await withTenant(invokerPool, t.accountId, t.userId, (c) => insertCompensation(c, { reversalReceiptId: r.id, kind: 'rerun', state: 'pending', ...over }));
    return { id, workItemId, receiptId: r.id };
  }
  const due = async () => listDueCompensations(invokerPool, 100);
  const fail = async (id: string, reasonCode: CompensationReason) => {
    expect(await claimCompensation(invokerPool, id)).not.toBeNull();
    expect(await finishCompensation(invokerPool, id, { state: 'failed', reasonCode })).toBe(true);
  };

  it('the CHECK accepts the ten 0933 codes and the four new ones, and still refuses anything else', async () => {
    const t = await seedAccount(admin, randomUUID());
    for (const code of ALL_REASONS) {
      const { id } = await row(t);
      await fail(id, code);
      expect((await admin.query('SELECT reason_code FROM reversal_compensations WHERE id = $1', [id])).rows[0].reason_code).toBe(code);
    }
    const { id } = await row(t);
    await claimCompensation(invokerPool, id);
    await expect(finishCompensation(invokerPool, id, { state: 'failed', reasonCode: 'we_undid_it' as CompensationReason })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    const def = (await admin.query(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'reversal_compensations_reason_code_check'`)).rows;
    expect(def).toHaveLength(1);
    for (const code of ALL_REASONS) expect(def[0].d).toContain(`'${code}'`);
  });

  it('the lister: owner platform_ops, pinned search_path, EXECUTE for the invoker only; a platform_ops login and the app role are refused', async () => {
    const r = (await admin.query(
      `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, p.proconfig AS config,
              EXISTS (SELECT 1 FROM aclexplode(p.proacl) x WHERE x.grantee = 0) AS public_grant,
              (SELECT array_agg(DISTINCT pg_get_userbyid(x.grantee)::text) FROM aclexplode(p.proacl) x WHERE x.grantee <> p.proowner) AS grantees
         FROM pg_proc p WHERE p.oid = 'reversal_compensation_due(integer)'::regprocedure`)).rows[0];
    expect(r).toEqual({ owner: 'platform_ops', definer: true, config: ['search_path=pg_catalog, public, pg_temp'], public_grant: false, grantees: ['receipt_writer_invoker'] });
    await expect(opsPool.query('SELECT * FROM reversal_compensation_due(10)')).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    await expect(appPool.query('SELECT * FROM reversal_compensation_due(10)')).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    for (const bad of [0, 101]) await expect(invokerPool.query('SELECT * FROM reversal_compensation_due($1)', [bad])).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
  });

  it('lists pending rows of every account, and a tooling_error failure until the cap; never another failure, a finished, waiting or refused row', async () => {
    const a = await seedAccount(admin, randomUUID());
    const b = await seedAccount(admin, randomUUID());
    const pendingA = await row(a);
    const pendingB = await row(b, { kind: 'revert_pr' });
    const waiting = await row(a, { state: 'awaiting_confirm', estimateUsd: 1 });
    const refused = await row(a, { kind: 'refused', state: 'done', reasonCode: 'not_reversible' });
    const transient = await row(a);
    await fail(transient.id, 'tooling_error');
    const terminal: string[] = [];
    for (const code of ['no_installation', 'repo_gone', 'head_moved', 'person_managed', 'rerun_refused'] as const) {
      const r = await row(a);
      await fail(r.id, code);
      terminal.push(r.id);
    }
    const finished = await row(a);
    await claimCompensation(invokerPool, finished.id);
    await finishCompensation(invokerPool, finished.id, { state: 'done', prNumber: 7 });
    const ids = await due();
    expect(ids).toEqual(expect.arrayContaining([pendingA.id, pendingB.id, transient.id]));
    for (const id of [waiting.id, refused.id, finished.id, ...terminal]) expect(ids).not.toContain(id);
    // Retried until the cap, then never listed again.
    for (let i = 2; i <= COMPENSATION_MAX_ATTEMPTS; i += 1) await fail(transient.id, 'tooling_error');
    expect(await due()).not.toContain(transient.id);
    // An account that is no longer active is not listed.
    await admin.query('UPDATE accounts SET deleted_at = now() WHERE id = $1', [b.accountId]);
    expect(await due()).not.toContain(pendingB.id);
    await admin.query('UPDATE accounts SET deleted_at = NULL WHERE id = $1', [b.accountId]);
  });

  it('reversalHoldsClose: held while a re-run row runs (for a bounded time) and after it is done for that pull request; not otherwise', async () => {
    const t = await seedAccount(admin, randomUUID());
    const held = (r: { workItemId: string }, pr: number) => withTenant(appPool, t.accountId, t.userId, (c) => reversalHoldsClose(c, r.workItemId, pr));
    const r = await row(t);
    expect(await held(r, 7)).toBe(false);
    await claimCompensation(invokerPool, r.id);
    expect(await held(r, 7)).toBe(true);
    await admin.query(`UPDATE reversal_compensations SET updated_at = now() - make_interval(secs => $2) WHERE id = $1`, [r.id, REVERSAL_CLOSE_HOLD_SECONDS + 5]);
    expect(await held(r, 7)).toBe(false);
    await admin.query(`UPDATE reversal_compensations SET updated_at = now() WHERE id = $1`, [r.id]);
    await finishCompensation(invokerPool, r.id, { state: 'done', prNumber: 7 });
    expect(await held(r, 7)).toBe(true);
    expect(await held(r, 8)).toBe(false);
    // A failed re-run, and a revert row, never hold a close.
    const f = await row(t);
    await fail(f.id, 'head_moved');
    expect(await held(f, 7)).toBe(false);
    const v = await row(t, { kind: 'revert_pr' });
    await claimCompensation(invokerPool, v.id);
    expect(await held(v, 7)).toBe(false);
    // Another account's tenant sees nothing to hold.
    const other = await seedAccount(admin, randomUUID());
    expect(await withTenant(appPool, other.accountId, other.userId, (c) => reversalHoldsClose(c, r.workItemId, 7))).toBe(false);
  });
});
