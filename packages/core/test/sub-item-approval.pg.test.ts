import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RECEIPT_HOOK_DEADLINE_MS } from '../src/decisions/receiptHook.js';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { SubItemApprovalError, approveSubItem } from '../src/decisions/approveSubItem.js';
import { withTenant } from '../src/tenancy/withTenant.js';

/**
 * D#483 S5-b2a part 1: approveSubItem against a real Postgres, on the receipt pool (app_user + receipt_writer_invoker). It is a person's
 * Approve on one sub-item: the receipt carries that person as the actor and is keyed by the Spec version, and the matching open ask closes.
 */
const LOGIN = 'fx_sub_item_approval_core_test';
const OPTIONS = JSON.stringify([{ id: 'launch', label: 'Launch it' }, { id: 'wait', label: 'Wait' }]);

describe('approveSubItem (D#483 S5-b2a)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let receiptPool: Pool;
  let appPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    await admin.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${LOGIN}') THEN
          CREATE ROLE ${LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        END IF;
      END $$`);
    await admin.query(`GRANT app_user, receipt_writer_invoker TO ${LOGIN}`);
    const u = new URL(process.env.DATABASE_URL_APP_USER!);
    u.username = LOGIN;
    u.password = '';
    receiptPool = createPool(u.toString());
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), receiptPool.end(), appPool.end()]);
  });

  interface Fixture {
    t: SeedRefs;
    workItemId: string;
    reviewRun: string;
    specId: string;
    approver: string;
  }
  async function addUser(t: SeedRefs, role: 'owner' | 'admin' | 'member'): Promise<string> {
    const id = randomUUID();
    await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [id, `${id}@example.test`]);
    await admin.query('INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)', [t.accountId, id, role]);
    return id;
  }
  async function addSpec(t: SeedRefs, workItemId: string, version: number): Promise<string> {
    const body = `Spec ${version} ${randomUUID()}`;
    return (await admin.query<{ id: string }>(
      `INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, $3, $4, $5, 'agent') RETURNING id`,
      [t.accountId, workItemId, version, body, createHash('sha256').update(body).digest('hex')],
    )).rows[0]!.id;
  }
  const addRun = async (t: SeedRefs, workItemId: string, role: string, extra: { specId?: string; status?: string } = {}): Promise<string> =>
    (await admin.query<{ id: string }>(
      `INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, spec_version_id) VALUES ($1, $2, $3, 'local', $4, $5) RETURNING id`,
      [t.accountId, workItemId, role, extra.status ?? 'succeeded', extra.specId ?? null],
    )).rows[0]!.id;
  /** An approved item: a person's approval row names the current Spec version, and a reviewer run has finished. */
  async function fixture(o: { approved?: boolean } = {}): Promise<Fixture> {
    const t = await seedAccount(admin, randomUUID());
    const workItemId = (await admin.query<{ id: string }>(`INSERT INTO work_items (account_id, repo_id, kind, provenance, title) VALUES ($1, $2, 'issue', 'internal', 'Fix it') RETURNING id`, [t.accountId, t.repoId])).rows[0]!.id;
    const specId = await addSpec(t, workItemId, 1);
    const reviewRun = await addRun(t, workItemId, 'code-reviewer');
    const approver = await addUser(t, 'admin');
    if (o.approved !== false) {
      await withTenant(appPool, t.accountId, approver, (c) => c.query(`SELECT * FROM work_item_approval_record($1, 'work_item_approve')`, [workItemId]));
    }
    return { t, workItemId, reviewRun, specId, approver };
  }
  const approve = (f: Fixture, key = 'fix-1', userId = f.approver, tokenId?: string) =>
    approveSubItem({ pool: receiptPool, principal: { accountId: f.t.accountId, userId, ...(tokenId ? { tokenId } : {}) } }, { workItemId: f.workItemId, key });
  const raiseAsk = async (f: Fixture, runId: string, type = 'launch_sub_item', key = 'fix-1'): Promise<string> => {
    const id = await withTenant(receiptPool, f.t.accountId, async (c) => (await c.query<{ id: string }>(
      `SELECT decision_ask_raise('human_over_the_loop', $1::text, $2::uuid, $3::uuid, $4::jsonb, 'launch', 'because', '["trusted"]'::jsonb, 60, 'stop_and_flag', 0) AS id`,
      [type, f.workItemId, runId, OPTIONS])).rows[0]!.id);
    await admin.query('UPDATE decision_asks SET sub_item_key = $2 WHERE id = $1', [id, key]);
    return id;
  };
  const askState = async (id: string) => (await admin.query('SELECT state, withdrawn_reason FROM decision_asks WHERE id = $1', [id])).rows[0];
  const refused = (p: Promise<unknown>, code: string) => expect(p).rejects.toMatchObject({ name: 'SubItemApprovalError', code });
  const receiptsOf = async (f: Fixture) => (await admin.query('SELECT * FROM decision_receipts WHERE work_item_id = $1 ORDER BY created_at', [f.workItemId])).rows;

  it('writes the person\'s receipt on the review run, keyed by the Spec version, and closes the matching ask', async () => {
    const f = await fixture();
    const ask = await raiseAsk(f, f.reviewRun);
    const done = await approve(f);
    expect(done).toMatchObject({ replayed: false, specVersionId: f.specId, withdrawnAsks: 1 });
    expect(await receiptsOf(f)).toMatchObject([{
      id: done.receiptId, actor: f.approver, decision_type: 'launch_sub_item', class: 'human_over_the_loop', run_id: f.reviewRun,
      sub_item_key: 'fix-1', spec_version_id: f.specId, dial_version: 0,
    }]);
    expect(await askState(ask)).toEqual({ state: 'withdrawn', withdrawn_reason: 'superseded' });
  });

  it('D#7 DP6a-WIRING: a receipt hook that never resolves holds the approval for the deadline at most; the receipt is committed', async () => {
    const f = await fixture();
    const hook = vi.fn(() => new Promise<void>(() => undefined));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const t0 = Date.now();
    const done = await approveSubItem({ pool: receiptPool, principal: { accountId: f.t.accountId, userId: f.approver }, afterReceipt: hook }, { workItemId: f.workItemId, key: 'fix-1' });
    expect(Date.now() - t0).toBeLessThan(RECEIPT_HOOK_DEADLINE_MS + 4000);
    warn.mockRestore();
    expect(hook).toHaveBeenCalledWith({ accountId: f.t.accountId, workItemId: f.workItemId });
    expect(await receiptsOf(f)).toMatchObject([{ id: done.receiptId }]);
  }, 20_000);

  it('is idempotent: the same key under the same Spec is the same receipt, and no second ask is touched', async () => {
    const f = await fixture();
    const first = await approve(f);
    const again = await approve(f);
    expect(again).toMatchObject({ receiptId: first.receiptId, replayed: true, withdrawnAsks: 0 });
    expect(await receiptsOf(f)).toHaveLength(1);
  });

  it('closes only the ask of the approved key: a sibling planned PR on the same anchor run, and an ask of another type, stay open', async () => {
    const f = await fixture();
    const pm = await addRun(f.t, f.workItemId, 'project-manager', { specId: f.specId });
    const login = await raiseAsk(f, pm, 'launch_sub_item', 'login-page');
    const signup = await raiseAsk(f, pm, 'launch_sub_item', 'signup-page');
    const otherType = await raiseAsk(f, pm, 'spend_past_envelope', 'login-page');
    const done = await approve(f, 'login-page');
    expect(done.withdrawnAsks).toBe(1);
    expect((await askState(login)).state).toBe('withdrawn');
    expect((await askState(signup)).state).toBe('open');
    expect((await askState(otherType)).state).toBe('open');
    expect((await receiptsOf(f))[0]).toMatchObject({ run_id: pm, sub_item_key: 'login-page' });
  });

  it('anchors a fix round on the open ask\'s run when one exists', async () => {
    const f = await fixture();
    const security = await addRun(f.t, f.workItemId, 'security-reviewer');
    const ask = await raiseAsk(f, f.reviewRun);
    const done = await approve(f);
    expect(done.withdrawnAsks).toBe(1);
    expect((await receiptsOf(f))[0]).toMatchObject({ run_id: f.reviewRun });
    expect((await askState(ask)).state).toBe('withdrawn');
    expect(security).not.toBe(f.reviewRun);
  });

  it('anchors a fix round only on a SUCCEEDED run of a verdict role', async () => {
    const f = await fixture();
    await addRun(f.t, f.workItemId, 'accessibility-reviewer'); // advisory: no verdict
    await addRun(f.t, f.workItemId, 'security-reviewer', { status: 'failed' });
    await addRun(f.t, f.workItemId, 'executor');
    const newest = await addRun(f.t, f.workItemId, 'acceptance-tester');
    await approve(f);
    expect((await receiptsOf(f))[0]).toMatchObject({ run_id: newest });
  });

  it('refuses a fix round with no succeeded verdict run: a failed run, or the wrong role, is no anchor', async () => {
    const failed = await fixture();
    await admin.query(`UPDATE agent_runs SET status = 'failed' WHERE id = $1`, [failed.reviewRun]);
    await refused(approve(failed), 'no_anchor_run');
    const only = await fixture();
    await admin.query(`UPDATE agent_runs SET status = 'running' WHERE id = $1`, [only.reviewRun]);
    await addRun(only.t, only.workItemId, 'accessibility-reviewer');
    await addRun(only.t, only.workItemId, 'executor');
    await refused(approve(only), 'no_anchor_run');
    expect(await receiptsOf(failed)).toHaveLength(0);
    expect(await receiptsOf(only)).toHaveLength(0);
  });

  it('accepts only the NEXT fix round: a future round or a round already started is wrong_round', async () => {
    const f = await fixture();
    await refused(approve(f, 'fix-3'), 'wrong_round');
    await refused(approve(f, 'fix-9'), 'wrong_round');
    await refused(approve(f, 'fix-0'), 'invalid_key');
    await refused(approve(f, 'fix-x'), 'invalid_key');
    expect(await receiptsOf(f)).toHaveLength(0);
    await admin.query(`INSERT INTO work_item_driver_events (account_id, work_item_id, kind, dedupe_key) VALUES ($1, $2, 'fix_round_started', 'r1')`, [f.t.accountId, f.workItemId]);
    await refused(approve(f, 'fix-1'), 'wrong_round');
    expect((await approve(f, 'fix-2')).replayed).toBe(false);
  });

  it('a re-spec makes the earlier approval stop counting: the parent must be approved again first, and then a new receipt is written', async () => {
    const f = await fixture();
    const first = await approve(f);
    const s2 = await addSpec(f.t, f.workItemId, 2);
    await refused(approve(f), 'respec_needs_approval');
    await withTenant(appPool, f.t.accountId, f.approver, (c) => c.query(`SELECT * FROM work_item_approval_record($1, 'reapprove_after_respec')`, [f.workItemId]));
    const second = await approve(f);
    expect(second.receiptId).not.toBe(first.receiptId);
    expect(second.specVersionId).toBe(s2);
    expect((await receiptsOf(f)).map((r) => r.spec_version_id)).toEqual([f.specId, s2]);
  });

  it('refuses a token, a plain member, an unknown or foreign item, a malformed key and an item without an approval, Spec or anchor run', async () => {
    const f = await fixture();
    const member = await addUser(f.t, 'member');
    const token = (await admin.query<{ id: string }>(
      `INSERT INTO api_tokens (account_id, created_by, token_hash, display_hint, scopes, expires_at) VALUES ($1, $2, $3, 'fxat_x', ARRAY['read'], now() + interval '1 day') RETURNING id`,
      [f.t.accountId, f.approver, randomUUID()],
    )).rows[0]!.id;
    await refused(approve(f, 'fix-1', f.approver, token), 'session_required');
    await refused(approve(f, 'fix-1', member), 'forbidden');
    await refused(approve(f, 'fix-1', randomUUID()), 'session_required');
    await refused(approve(f, 'Fix 1'), 'invalid_key');
    await refused(approveSubItem({ pool: receiptPool, principal: { accountId: f.t.accountId, userId: f.approver } }, { workItemId: randomUUID(), key: 'fix-1' }), 'not_found');
    await refused(approveSubItem({ pool: receiptPool, principal: { accountId: f.t.accountId, userId: f.approver } }, { workItemId: 'nope', key: 'fix-1' }), 'not_found');
    const other = await fixture();
    await refused(approveSubItem({ pool: receiptPool, principal: { accountId: f.t.accountId, userId: f.approver } }, { workItemId: other.workItemId, key: 'fix-1' }), 'not_found');
    await refused(approve(await fixture({ approved: false })), 'parent_not_approved');
    const noSpec = await fixture();
    await admin.query('UPDATE spec_versions SET erased_at = now() WHERE id = $1', [noSpec.specId]);
    await refused(approve(noSpec), 'no_spec');
    const noRun = await fixture();
    await admin.query(`UPDATE agent_runs SET status = 'running' WHERE id = $1`, [noRun.reviewRun]);
    await refused(approve(noRun), 'no_anchor_run');
    // A planned PR's key hangs on the run that published the approved Spec, not on a review run.
    await refused(approve(f, 'login-page'), 'no_anchor_run');
    expect(await receiptsOf(f)).toHaveLength(0);
    expect(new SubItemApprovalError('forbidden').status).toBe(403);
  });

  it('anchors a planned PR\'s key on the run that published the approved Spec', async () => {
    const f = await fixture();
    const pm = await addRun(f.t, f.workItemId, 'project-manager', { specId: f.specId });
    const done = await approve(f, 'login-page');
    expect((await receiptsOf(f))[0]).toMatchObject({ id: done.receiptId, run_id: pm, sub_item_key: 'login-page' });
  });
});
