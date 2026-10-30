import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withdrawSubItemAsk } from '../src/decisionAsks.js';
import { writeSubItemApprovalReceipt } from '../src/receiptWriter.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * [pg] D#483 S5-b2a part 1 (migration 0906) with the real roles: the append-only approval record, the three writers (approve_proposal,
 * work_item_approval_record), the person's launch_sub_item receipt keyed by Spec version, and the narrow ask withdrawal by id.
 */
const RECEIPT_LOGIN = 'fx_work_item_approvals_test';

describe('migration 0906: work_item_approvals and the sub-item approval [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let opsPool: Pool;
  let receiptPool: Pool;
  let n = 0;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    await admin.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RECEIPT_LOGIN}') THEN
          CREATE ROLE ${RECEIPT_LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        END IF;
      END $$`);
    await admin.query(`GRANT app_user, receipt_writer_invoker TO ${RECEIPT_LOGIN}`);
    const u = new URL(process.env.DATABASE_URL_APP_USER!);
    u.username = RECEIPT_LOGIN;
    u.password = '';
    receiptPool = createPool(u.toString());
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), receiptPool.end(), appPool.end(), opsPool.end()]);
  });

  async function person(t: SeedRefs, role: 'owner' | 'admin' | 'member'): Promise<string> {
    const id = randomUUID();
    await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [id, `${id}@example.test`]);
    await admin.query('INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)', [t.accountId, id, role]);
    return id;
  }
  const runs = new Map<string, string>();
  /** A work item with one finished run of its own (the anchor run a receipt and an ask hang on). */
  async function item(t: SeedRefs): Promise<string> {
    const id = (await admin.query<{ id: string }>(`INSERT INTO work_items (account_id, repo_id, kind, provenance, title) VALUES ($1, $2, 'issue', 'internal', 'Fix it') RETURNING id`, [t.accountId, t.repoId])).rows[0]!.id;
    const run = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'reviewer', 'local', 'succeeded')`, [run, t.accountId, id]);
    runs.set(id, run);
    return id;
  }
  async function spec(t: SeedRefs, workItemId: string, version: number): Promise<string> {
    const body = `Spec v${version} ${randomUUID()}`;
    return (await admin.query<{ id: string }>(
      `INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, $3, $4, $5, 'agent') RETURNING id`,
      [t.accountId, workItemId, version, body, createHash('sha256').update(body).digest('hex')],
    )).rows[0]!.id;
  }
  async function newProposal(t: SeedRefs): Promise<string> {
    return (await admin.query<{ id: string }>(
      `INSERT INTO proposals (account_id, repo_id, dedupe_key, sources, title, provenance, owner_process) VALUES ($1, $2, $3, '{github_issue}', 'Fix the typo', 'internal', 'product') RETURNING id`,
      [t.accountId, t.repoId, `gh:issue:${++n}`],
    )).rows[0]!.id;
  }
  const rowsOf = async (workItemId: string) => (await admin.query('SELECT * FROM work_item_approvals WHERE work_item_id = $1 ORDER BY created_at, id', [workItemId])).rows;
  const record = (t: SeedRefs, userId: string, workItemId: string, source: string, tokenId?: string) =>
    withTenant(appPool, t.accountId, userId, tokenId, async (c) => (await c.query('SELECT * FROM work_item_approval_record($1, $2)', [workItemId, source])).rows[0]);

  describe('the table', () => {
    it('is append-only for app_user and refuses an approver who is not a person', async () => {
      const t = await seedAccount(admin, randomUUID());
      const w = await item(t);
      await expect(appPool.query(`INSERT INTO work_item_approvals (account_id, work_item_id, approved_by, source) VALUES ($1, $2, $3, 'work_item_approve')`, [t.accountId, w, t.userId]))
        .rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      const ins = (by: string | null, source = 'work_item_approve') =>
        admin.query(`INSERT INTO work_item_approvals (account_id, work_item_id, approved_by, source) VALUES ($1, $2, $3, $4)`, [t.accountId, w, by, source]);
      await expect(ins(null)).rejects.toMatchObject({ code: '23502' });
      await expect(ins(randomUUID())).rejects.toMatchObject({ code: '23503' });
      await expect(ins('00000000-0000-0000-0000-000000000000')).rejects.toMatchObject({ code: '23503' });
      await expect(ins(t.userId, 'dial')).rejects.toMatchObject({ code: '23514' });
      await ins(t.userId);
      await expect(appPool.query('UPDATE work_item_approvals SET source = $1', ['proposal_approve'])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(appPool.query('DELETE FROM work_item_approvals')).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      const { rows } = await admin.query<{ r: string; ok: boolean }>(
        `SELECT r, has_table_privilege(r, 'work_item_approvals', 'UPDATE') OR has_table_privilege(r, 'work_item_approvals', 'DELETE') AS ok
           FROM unnest(ARRAY['app_user', 'platform_ops', 'receipt_writer', 'receipt_writer_invoker']) r`,
      );
      expect(rows.filter((r) => r.ok)).toEqual([]);
    });

    it('shows a tenant only its own rows', async () => {
      const a = await seedAccount(admin, randomUUID());
      const b = await seedAccount(admin, randomUUID());
      const w = await item(a);
      await record(a, a.userId, w, 'work_item_approve');
      const seen = (t: SeedRefs) => withTenant(appPool, t.accountId, t.userId, async (c) => (await c.query('SELECT id FROM work_item_approvals')).rows.length);
      expect(await seen(a)).toBeGreaterThanOrEqual(1);
      expect(await seen(b)).toBe(0);
    });
  });

  describe('approve_proposal writes the person row', () => {
    it('writes one proposal_approve row for the signed-in owner, none for a replay, and none when it refuses', async () => {
      const t = await seedAccount(admin, randomUUID());
      const w = await item(t);
      const p = await newProposal(t);
      const approve = () => withTenant(appPool, t.accountId, t.userId, async (c) => (await c.query('SELECT * FROM approve_proposal($1, $2)', [p, w])).rows[0]);
      expect((await approve()).replayed).toBe(false);
      const rows = await rowsOf(w);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ approved_by: t.userId, source: 'proposal_approve', spec_version_id: null, account_id: t.accountId });
      expect((await approve()).replayed).toBe(true);
      expect(await rowsOf(w)).toHaveLength(1);

      const w2 = await item(t);
      const p2 = await newProposal(t);
      await admin.query(`UPDATE work_items SET stage = 'discussing' WHERE id = $1`, [w2]);
      await expect(withTenant(appPool, t.accountId, t.userId, (c) => c.query('SELECT * FROM approve_proposal($1, $2)', [p2, w2]))).rejects.toThrow(/work_item_wrong_stage/);
      expect(await rowsOf(w2)).toHaveLength(0);
    });

    it('writes no row for a token approval: no person clicked, so the gate will ask', async () => {
      const t = await seedAccount(admin, randomUUID());
      const creator = await person(t, 'admin');
      const tok = (await admin.query<{ id: string }>(
        `INSERT INTO api_tokens (account_id, created_by, token_hash, display_hint, scopes, expires_at) VALUES ($1, $2, $3, 'fxat_x', ARRAY['read', 'work_items:write'], now() + interval '1 day') RETURNING id`,
        [t.accountId, creator, randomUUID()],
      )).rows[0]!.id;
      const w = await item(t);
      const p = await newProposal(t);
      const res = await withTenant(appPool, t.accountId, creator, tok, (c) => c.query('SELECT * FROM approve_proposal($1, $2)', [p, w]));
      expect(res.rows[0]).toMatchObject({ state: 'approved', replayed: false });
      expect(await rowsOf(w)).toEqual([]);
    });
  });

  describe('work_item_approval_record', () => {
    it('the two writers are owned by work_item_approval_definer, security definer, with EXECUTE for their callers only', async () => {
      const { rows } = await admin.query(
        `SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig,
                (SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END)
                   FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner) AS grantees
           FROM pg_proc p WHERE p.proname IN ('work_item_approval_record', 'work_item_approval_for_proposal') ORDER BY 1`,
      );
      const config = ['search_path=pg_catalog, public, pg_temp'];
      expect(rows).toEqual([
        { proname: 'work_item_approval_for_proposal', owner: 'work_item_approval_definer', prosecdef: true, proconfig: config, grantees: ['platform_ops'] },
        { proname: 'work_item_approval_record', owner: 'work_item_approval_definer', prosecdef: true, proconfig: config, grantees: ['app_user'] },
      ]);
    });

    it('platform_ops gains no privilege on the table, and the proposal writer is closed to app_user', async () => {
      const { rows } = await admin.query<{ r: string; ok: boolean }>(
        `SELECT r, has_table_privilege(r, 'work_item_approvals', 'SELECT,INSERT,UPDATE,DELETE') AS ok FROM unnest(ARRAY['platform_ops', 'receipt_writer', 'receipt_writer_invoker']) r`,
      );
      expect(rows.filter((r) => r.ok)).toEqual([]);
      const t = await seedAccount(admin, randomUUID());
      const w = await item(t);
      await expect(withTenant(appPool, t.accountId, t.userId, (c) => c.query('SELECT work_item_approval_for_proposal($1, $2)', [w, t.userId]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect(await rowsOf(w)).toEqual([]);
    });

    it('records the person and the Spec version in force, and replays an unchanged approval', async () => {
      const t = await seedAccount(admin, randomUUID());
      const w = await item(t);
      const first = await record(t, t.userId, w, 'work_item_approve');
      expect(first).toMatchObject({ o_spec_version_id: null, o_replayed: false });
      const s1 = await spec(t, w, 1);
      const second = await record(t, t.userId, w, 'work_item_approve');
      expect(second).toMatchObject({ o_spec_version_id: s1, o_replayed: false });
      expect(await record(t, t.userId, w, 'work_item_approve')).toMatchObject({ o_approval_id: second.o_approval_id, o_replayed: true });
      const rows = await rowsOf(w);
      expect(rows.map((r) => [r.source, r.approved_by, r.spec_version_id])).toEqual([['work_item_approve', t.userId, null], ['work_item_approve', t.userId, s1]]);
    });

    it('refuses a plain member, a token, a platform_ops login and bad arguments, and writes nothing', async () => {
      const t = await seedAccount(admin, randomUUID());
      const w = await item(t);
      const member = await person(t, 'member');
      await expect(record(t, member, w, 'work_item_approve')).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      const tok = (await admin.query<{ id: string }>(
        `INSERT INTO api_tokens (account_id, created_by, token_hash, display_hint, scopes, expires_at) VALUES ($1, $2, $3, 'fxat_x', ARRAY['read'], now() + interval '1 day') RETURNING id`,
        [t.accountId, t.userId, randomUUID()],
      )).rows[0]!.id;
      await expect(record(t, t.userId, w, 'work_item_approve', tok)).rejects.toMatchObject({ code: '55000', message: 'person_required' });
      await expect(record(t, t.userId, w, 'proposal_approve')).rejects.toMatchObject({ code: '22023' });
      await expect(record(t, t.userId, randomUUID(), 'work_item_approve')).rejects.toMatchObject({ code: 'P0002' });
      await expect(withTenant(opsPool, t.accountId, t.userId, (c) => c.query('SELECT * FROM work_item_approval_record($1, $2)', [w, 'work_item_approve']))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect(await rowsOf(w)).toHaveLength(0);
    });

    it('records another tenant\'s item as not found', async () => {
      const a = await seedAccount(admin, randomUUID());
      const b = await seedAccount(admin, randomUUID());
      const w = await item(b);
      await expect(record(a, a.userId, w, 'work_item_approve')).rejects.toMatchObject({ code: 'P0002' });
    });

    it('re-approves only after a re-spec, naming the new version', async () => {
      const t = await seedAccount(admin, randomUUID());
      const w = await item(t);
      await expect(record(t, t.userId, w, 'reapprove_after_respec')).rejects.toThrow(/parent_not_approved/);
      await record(t, t.userId, w, 'work_item_approve');
      await expect(record(t, t.userId, w, 'reapprove_after_respec')).rejects.toThrow(/no_spec/);
      const s1 = await spec(t, w, 1);
      await record(t, t.userId, w, 'work_item_approve');
      await expect(record(t, t.userId, w, 'reapprove_after_respec')).rejects.toThrow(/not_respecced/);
      const s2 = await spec(t, w, 2);
      const again = await record(t, t.userId, w, 'reapprove_after_respec');
      expect(again).toMatchObject({ o_spec_version_id: s2, o_replayed: false });
      expect(await record(t, t.userId, w, 'reapprove_after_respec')).toMatchObject({ o_approval_id: again.o_approval_id, o_replayed: true });
      expect((await rowsOf(w)).map((r) => [r.source, r.spec_version_id]).slice(-2)).toEqual([['work_item_approve', s1], ['reapprove_after_respec', s2]]);
    });
  });

  describe('the person\'s launch_sub_item receipt', () => {
    const asPerson = (t: SeedRefs, userId: string, fn: (c: PoolClient) => Promise<unknown>, tokenId?: string) => withTenant(receiptPool, t.accountId, userId, tokenId, fn);
    const write = (c: PoolClient, _t: SeedRefs, w: string, s: string, key = 'fix-1') => writeSubItemApprovalReceipt(c, { runId: runs.get(w)!, workItemId: w, key, specVersionId: s, dialVersion: 0 });

    it('is owned by receipt_writer with EXECUTE for the receipt invoker only', async () => {
      const { rows } = await admin.query(
        `SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.prosecdef,
                (SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END)
                   FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner) AS grantees
           FROM pg_proc p WHERE p.proname IN ('sub_item_approval_receipt_write', 'decision_ask_withdraw_by_id') ORDER BY 1`,
      );
      expect(rows).toEqual([
        { proname: 'decision_ask_withdraw_by_id', owner: 'receipt_writer', prosecdef: true, grantees: ['receipt_writer_invoker'] },
        { proname: 'sub_item_approval_receipt_write', owner: 'receipt_writer', prosecdef: true, grantees: ['receipt_writer_invoker'] },
        // Migration 0935's overload (the launch that came from the person's approval of the parent) is held to the same owner and grant.
        { proname: 'sub_item_approval_receipt_write', owner: 'receipt_writer', prosecdef: true, grantees: ['receipt_writer_invoker'] },
      ]);
    });

    it('writes the receipt in the approving person\'s name, keyed by Spec version', async () => {
      const t = await seedAccount(admin, randomUUID());
      const w = await item(t);
      const s1 = await spec(t, w, 1);
      const admin2 = await person(t, 'admin');
      const r1 = await asPerson(t, admin2, (c) => write(c, t, w, s1)) as { id: string; replayed: boolean };
      expect(r1.replayed).toBe(false);
      const row = (await admin.query('SELECT * FROM decision_receipts WHERE id = $1', [r1.id])).rows[0];
      expect(row).toMatchObject({
        actor: admin2, decision_type: 'launch_sub_item', class: 'human_over_the_loop', work_item_id: w, run_id: runs.get(w),
        sub_item_key: 'fix-1', spec_version_id: s1, chosen: 'launch', rejected_alternative: 'wait_for_approval',
      });
      // D#7 DP6a-WIRING: the definer's row carries the 24-hour reversal deadline, and a replay leaves no unspent window behind.
      expect((await admin.query(`SELECT (reversal_free_until - created_at) AS span FROM decision_receipts WHERE id = $1`, [r1.id])).rows[0].span).toEqual({ days: 1 });
      const left = await asPerson(t, t.userId, async (c) => { await write(c, t, w, s1); return (await c.query<{ v: string }>("SELECT current_setting('app.reversal_window_hours', true) AS v")).rows[0]!.v; });
      expect(left).toBe('');
      // The same key under the same Spec version is the same receipt, from either person.
      expect(await asPerson(t, t.userId, (c) => write(c, t, w, s1))).toEqual({ id: r1.id, replayed: true });
      // Another key, or another Spec version, is a new receipt.
      const other = await asPerson(t, t.userId, (c) => write(c, t, w, s1, 'fix-2')) as { id: string };
      const s2 = await spec(t, w, 2);
      const respec = await asPerson(t, t.userId, (c) => write(c, t, w, s2)) as { id: string; replayed: boolean };
      expect(new Set([r1.id, other.id, respec.id]).size).toBe(3);
      expect(respec.replayed).toBe(false);
    });

    it('refuses a plain member, a token, a session with no person and a malformed key, and writes nothing', async () => {
      const t = await seedAccount(admin, randomUUID());
      const w = await item(t);
      const s1 = await spec(t, w, 1);
      const member = await person(t, 'member');
      await expect(asPerson(t, member, (c) => write(c, t, w, s1))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      const tok = (await admin.query<{ id: string }>(
        `INSERT INTO api_tokens (account_id, created_by, token_hash, display_hint, scopes, expires_at) VALUES ($1, $2, $3, 'fxat_x', ARRAY['read'], now() + interval '1 day') RETURNING id`,
        [t.accountId, t.userId, randomUUID()],
      )).rows[0]!.id;
      await expect(asPerson(t, t.userId, (c) => write(c, t, w, s1), tok)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(withTenant(receiptPool, t.accountId, (c) => write(c, t, w, s1))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(asPerson(t, t.userId, (c) => write(c, t, w, s1, 'Fix 1'))).rejects.toMatchObject({ code: 'receipt_chosen_invalid' });
      await expect(appPool.query(`SELECT * FROM sub_item_approval_receipt_write($1, 'fix-1', $2, $3, 0, 1)`, [w, s1, runs.get(w)])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect(Number((await admin.query(`SELECT count(*) n FROM decision_receipts WHERE work_item_id = $1`, [w])).rows[0].n)).toBe(0);
    });

    it('cannot name another tenant\'s Spec version', async () => {
      const a = await seedAccount(admin, randomUUID());
      const b = await seedAccount(admin, randomUUID());
      const wb = await item(b);
      const sb = await spec(b, wb, 1);
      const wa = await item(a);
      await expect(asPerson(a, a.userId, (c) => write(c, a, wa, sb))).rejects.toMatchObject({ code: '22023' });
    });

    it('refuses a Spec version that is not the item\'s newest, another item\'s Spec or run, and an erased version, and writes nothing', async () => {
      const t = await seedAccount(admin, randomUUID());
      const w = await item(t);
      const other = await item(t);
      const s1 = await spec(t, w, 1);
      const otherSpec = await spec(t, other, 1);
      const s2 = await spec(t, w, 2);
      await expect(asPerson(t, t.userId, (c) => write(c, t, w, s1))).rejects.toMatchObject({ code: '22023' });
      await expect(asPerson(t, t.userId, (c) => write(c, t, w, otherSpec))).rejects.toMatchObject({ code: '22023' });
      await expect(asPerson(t, t.userId, (c) => writeSubItemApprovalReceipt(c, { runId: runs.get(other)!, workItemId: w, key: 'fix-1', specVersionId: s2, dialVersion: 0 }))).rejects.toMatchObject({ code: '22023' });
      await admin.query('UPDATE spec_versions SET erased_at = now() WHERE id = $1', [s2]);
      await expect(asPerson(t, t.userId, (c) => write(c, t, w, s2))).rejects.toMatchObject({ code: '22023' });
      expect(Number((await admin.query(`SELECT count(*) n FROM decision_receipts WHERE work_item_id = $1`, [w])).rows[0].n)).toBe(0);
    });
  });

  describe('decision_ask_withdraw_by_id', () => {
    const RAISE = `SELECT decision_ask_raise('human_over_the_loop', $1::text, $2::uuid, $3::uuid, '[{"id":"launch","label":"Launch"},{"id":"wait","label":"Wait"}]'::jsonb, 'launch',
                                              'because', '["trusted"]'::jsonb, 60, 'stop_and_flag', 0) AS id`;
    const raise = async (t: SeedRefs, w: string, type = 'launch_sub_item', key = 'fix-1'): Promise<string> => {
      const id = await withTenant(receiptPool, t.accountId, async (c) => (await c.query<{ id: string }>(RAISE, [type, w, runs.get(w)!])).rows[0]!.id);
      await admin.query('UPDATE decision_asks SET sub_item_key = $2 WHERE id = $1', [id, key]);
      return id;
    };
    const state = async (id: string) => (await admin.query('SELECT state, withdrawn_reason FROM decision_asks WHERE id = $1', [id])).rows[0];
    const withdraw = (t: SeedRefs, userId: string, id: string, tokenId?: string, key = 'fix-1') => withTenant(receiptPool, t.accountId, userId, tokenId, (c) => withdrawSubItemAsk(c, id, key));

    it('closes one open launch_sub_item ask as superseded, once', async () => {
      const t = await seedAccount(admin, randomUUID());
      const w = await item(t);
      const ask = await raise(t, w);
      const untouched = await raise(t, w, 'launch_sub_item', 'fix-2');
      expect(await withdraw(t, t.userId, ask)).toBe(true);
      expect(await state(ask)).toEqual({ state: 'withdrawn', withdrawn_reason: 'superseded' });
      expect(await state(untouched)).toEqual({ state: 'open', withdrawn_reason: null });
      expect(await withdraw(t, t.userId, ask)).toBe(false);
    });

    it('closes only the ask of the named key: a sibling key on the same run, and a wrong key, stay open', async () => {
      const t = await seedAccount(admin, randomUUID());
      const w = await item(t);
      const a = await raise(t, w, 'launch_sub_item', 'login-page');
      const b = await raise(t, w, 'launch_sub_item', 'signup-page');
      expect(await withdraw(t, t.userId, a, undefined, 'signup-page')).toBe(false);
      expect(await withdraw(t, t.userId, b, undefined, 'login-page')).toBe(false);
      expect((await state(a)).state).toBe('open');
      expect((await state(b)).state).toBe('open');
      expect(await withdraw(t, t.userId, a, undefined, 'login-page')).toBe(true);
      expect((await state(a)).state).toBe('withdrawn');
      expect((await state(b)).state).toBe('open');
      await expect(withdraw(t, t.userId, b, undefined, 'Bad Key')).rejects.toMatchObject({ code: '22023' });
    });

    it('leaves an ask of another type, another tenant\'s ask and an unknown id alone', async () => {
      const a = await seedAccount(admin, randomUUID());
      const b = await seedAccount(admin, randomUUID());
      const wa = await item(a);
      const wb = await item(b);
      const otherType = await raise(a, wa, 'spend_past_envelope');
      const foreign = await raise(b, wb);
      expect(await withdraw(a, a.userId, otherType)).toBe(false);
      expect(await withdraw(a, a.userId, foreign)).toBe(false);
      expect(await withdraw(a, a.userId, randomUUID())).toBe(false);
      expect((await state(otherType)).state).toBe('open');
      expect((await state(foreign)).state).toBe('open');
    });

    it('refuses a plain member, a token and a session with no person', async () => {
      const t = await seedAccount(admin, randomUUID());
      const w = await item(t);
      const ask = await raise(t, w);
      const member = await person(t, 'member');
      await expect(withdraw(t, member, ask)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      const tok = (await admin.query<{ id: string }>(
        `INSERT INTO api_tokens (account_id, created_by, token_hash, display_hint, scopes, expires_at) VALUES ($1, $2, $3, 'fxat_x', ARRAY['read'], now() + interval '1 day') RETURNING id`,
        [t.accountId, t.userId, randomUUID()],
      )).rows[0]!.id;
      await expect(withdraw(t, t.userId, ask, tok)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(withTenant(receiptPool, t.accountId, (c) => withdrawSubItemAsk(c, ask, 'fix-1'))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(appPool.query('SELECT decision_ask_withdraw_by_id($1, $2)', [ask, 'fix-1'])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect((await state(ask)).state).toBe('open');
    });
  });
});
