import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { answerAsk, listPendingAsks } from '../src/decisions/index.js';
import { raiseStartAsk, recordStartReceipt } from '../src/decisions/startGate.js';

/** D#7 start gate, part (a) (migration 0913): the work-item-anchored start ask, receipt and answer, against a real Postgres with the real roles. */
const INVOKER_LOGIN = 'fx_start_gate_test';

describe('start gate (migration 0913) [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let receiptPool: Pool;
  let appPool: Pool;
  let opsPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;
  let aAdmin: string;
  let aMember: string;

  async function addUser(accountId: string, role: 'admin' | 'member'): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [id, `${id}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [accountId, id, role]);
    return id;
  }
  async function item(t: SeedRefs): Promise<string> {
    return (await admin.query<{ id: string }>(`INSERT INTO work_items (account_id, repo_id, kind, provenance, title) VALUES ($1, $2, 'issue', 'internal', 'Fix it') RETURNING id`, [t.accountId, t.repoId])).rows[0]!.id;
  }

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    await admin.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${INVOKER_LOGIN}') THEN
          CREATE ROLE ${INVOKER_LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        END IF;
      END $$`);
    await admin.query(`GRANT app_user, receipt_writer_invoker TO ${INVOKER_LOGIN}`);
    const u = new URL(process.env.DATABASE_URL_APP_USER!);
    u.username = INVOKER_LOGIN;
    u.password = '';
    receiptPool = createPool(u.toString());
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    aAdmin = await addUser(a.accountId, 'admin');
    aMember = await addUser(a.accountId, 'member');
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), receiptPool.end(), appPool.end(), opsPool.end()]);
  });

  const as = (t: SeedRefs, userId: string = t.userId) => ({ pool: receiptPool, principal: { accountId: t.accountId, userId } });
  const gateCtx = (t: SeedRefs) => ({ pool: receiptPool, accountId: t.accountId });
  const raise = (t: SeedRefs, workItemId: string, decisionType: 'start_work_small' | 'start_parent_item' = 'start_work_small') =>
    raiseStartAsk(gateCtx(t), { workItemId, decisionType, preset: 'cautious' });
  const one = async (sql: string, args: unknown[]) => (await admin.query(sql, args)).rows[0];
  const gateOf = (wi: string, type = 'start_work_small') => one(`SELECT * FROM start_gate WHERE work_item_id = $1 AND decision_type = $2`, [wi, type]);
  const advances = async (wi: string) => (await admin.query(`SELECT * FROM run_action_requests WHERE kind = 'advance_work_item' AND target_id = $1`, [wi])).rows;
  const resumes = async (askId: string) => (await admin.query(`SELECT 1 FROM run_action_requests WHERE kind = 'resume_decision' AND target_id = $1`, [askId])).rows;
  const audit = async (t: SeedRefs, action: string, wi: string) =>
    (await admin.query(`SELECT * FROM audit_log WHERE account_id = $1 AND action = $2 AND payload ->> 'work_item_id' = $3`, [t.accountId, action, wi])).rows;
  const refused = (p: Promise<unknown>, status: number, code: string) => expect(p).rejects.toMatchObject({ name: 'AskAnswerError', status, code });

  it('raising a start ask makes one open ask with no run and one gate row; a second raise finds both', async () => {
    const wi = await item(a);
    const first = await raise(a, wi);
    expect(first).toMatchObject({ outcome: 'asked', replayed: false, receiptId: null });
    const ask = await one(`SELECT * FROM decision_asks WHERE id = $1`, [first.askId]);
    expect(ask).toMatchObject({ run_id: null, work_item_id: wi, decision_type: 'start_work_small', state: 'open', proposed: 'start' });
    expect(ask.rationale).toMatch(/^<<UNTRUSTED EXTERNAL CONTENT>>\n"Fix it": Your cautious setting asks/);
    expect(ask.input_trust_classes).toEqual(['untrusted']);
    expect(ask.options.map((o: { id: string }) => o.id)).toEqual(['start', 'hold']);
    expect(await gateOf(wi)).toMatchObject({ outcome: 'asked', ask_id: first.askId, preset: 'cautious', dial_version: 0, receipt_id: null });

    const again = await raise(a, wi);
    expect(again).toMatchObject({ gateId: first.gateId, askId: first.askId, outcome: 'asked', replayed: true });
    expect((await admin.query(`SELECT 1 FROM decision_asks WHERE work_item_id = $1`, [wi])).rows).toHaveLength(1);
    expect(await audit(a, 'start_gate.recorded', wi)).toHaveLength(1);
    expect((await audit(a, 'start_gate.recorded', wi))[0].actor).toBe('policy');
  });

  it('two raises at once make one ask', async () => {
    const wi = await item(a);
    const [x, y] = await Promise.all([raise(a, wi), raise(a, wi)]);
    expect(x.askId).toBe(y.askId);
    expect([x.replayed, y.replayed].sort()).toEqual([false, true]);
    expect((await admin.query(`SELECT 1 FROM decision_asks WHERE work_item_id = $1`, [wi])).rows).toHaveLength(1);
  });

  it('the pending list shows the ask with its options, ready for the Needs you buttons', async () => {
    const wi = await item(a);
    const { askId } = await raise(a, wi);
    const { asks } = await listPendingAsks({ pool: appPool, principal: { accountId: a.accountId, userId: a.userId } });
    const row = asks.find((x) => x.id === askId);
    expect(row).toMatchObject({ workItemId: wi, decisionType: 'start_work_small', proposed: 'start', state: 'open' });
    expect(row!.options).toEqual([{ id: 'start', label: 'Start it' }, { id: 'hold', label: 'Hold it for now' }]);
  });

  it('approving starts the item exactly once: a person-actor receipt, a startask-keyed advance request, no resume, audit rows; a replay changes nothing', async () => {
    const wi = await item(a);
    const { askId } = await raise(a, wi);
    const sent: unknown[] = [];
    const signal = { signal: async (m: unknown) => void sent.push(m) };
    const res = await answerAsk({ ...as(a, aAdmin), signal }, { askId: askId!, choice: 'start' });
    expect(res).toMatchObject({ askId, answeredOption: 'start' });
    expect(await one(`SELECT * FROM decision_asks WHERE id = $1`, [askId])).toMatchObject({ state: 'answered', answered_option: 'start', answered_by: aAdmin, receipt_id: res.receiptId });
    expect(await one(`SELECT * FROM decision_receipts WHERE id = $1`, [res.receiptId])).toMatchObject({
      account_id: a.accountId, run_id: null, work_item_id: wi, decision_type: 'start_work_small', class: 'human_over_the_loop',
      chosen: 'start', rejected_alternative: 'wait_for_approval', actor: aAdmin, dial_version: 0,
    });
    expect(await gateOf(wi)).toMatchObject({ outcome: 'started', receipt_id: res.receiptId, decided_by: aAdmin, preset: 'cautious' });
    const reqs = await advances(wi);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({ requested_by: `session:${aAdmin}`, principal_kind: 'session', idempotency_key: `startask:${askId}`, state: 'accepted' });
    expect(await resumes(askId!)).toEqual([]);
    expect(sent).toEqual([{ actionId: reqs[0].id, accountId: a.accountId, kind: 'advance_work_item' }]);
    expect(await audit(a, 'start_gate.answered', wi)).toHaveLength(1);
    expect((await admin.query(`SELECT 1 FROM audit_log WHERE account_id = $1 AND action = 'run_action.requested' AND payload ->> 'target_id' = $2`, [a.accountId, wi])).rows).toHaveLength(1);

    await refused(answerAsk(as(a), { askId: askId!, choice: 'start' }), 409, 'already_answered');
    expect(await advances(wi)).toHaveLength(1);
    expect((await admin.query(`SELECT 1 FROM decision_receipts WHERE work_item_id = $1`, [wi])).rows).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it('two people approving at once start it once', async () => {
    const wi = await item(a);
    const { askId } = await raise(a, wi);
    const settled = await Promise.allSettled([answerAsk(as(a), { askId: askId!, choice: 'start' }), answerAsk(as(a, aAdmin), { askId: askId!, choice: 'start' })]);
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    expect(await advances(wi)).toHaveLength(1);
    expect((await admin.query(`SELECT 1 FROM decision_receipts WHERE work_item_id = $1`, [wi])).rows).toHaveLength(1);
  });

  it('holding or denying records the decline with a receipt, closes the ask and requests nothing', async () => {
    const [w1, w2] = [await item(a), await item(a)];
    const hold = await answerAsk(as(a), { askId: (await raise(a, w1)).askId!, choice: 'hold' });
    const deny = await answerAsk(as(a), { askId: (await raise(a, w2)).askId!, choice: 'deny' });
    expect(await one(`SELECT * FROM decision_receipts WHERE id = $1`, [hold.receiptId])).toMatchObject({ run_id: null, chosen: 'hold', rejected_alternative: 'start', actor: a.userId });
    expect(await one(`SELECT * FROM decision_receipts WHERE id = $1`, [deny.receiptId])).toMatchObject({ chosen: 'deny', rejected_alternative: 'start' });
    expect(await gateOf(w1)).toMatchObject({ outcome: 'declined', receipt_id: hold.receiptId });
    expect(await gateOf(w2)).toMatchObject({ outcome: 'declined', receipt_id: deny.receiptId });
    expect(await one(`SELECT state, answered_option FROM decision_asks WHERE work_item_id = $1`, [w1])).toEqual({ state: 'answered', answered_option: 'hold' });
    expect([await advances(w1), await advances(w2)]).toEqual([[], []]);
    expect(await audit(a, 'start_gate.answered', w1)).toHaveLength(1);
    // A declined pair stays declined: a later raise finds the row and makes no second ask.
    expect(await raise(a, w1)).toMatchObject({ outcome: 'declined', replayed: true });
    expect((await admin.query(`SELECT 1 FROM decision_asks WHERE work_item_id = $1`, [w1])).rows).toHaveLength(1);
  });

  it('a plain member, a token and an outsider cannot answer; nothing is written', async () => {
    const wi = await item(a);
    const { askId } = await raise(a, wi);
    await refused(answerAsk(as(a, aMember), { askId: askId!, choice: 'start' }), 403, 'forbidden');
    await refused(answerAsk({ pool: receiptPool, principal: { accountId: a.accountId, userId: a.userId, tokenId: randomUUID() } }, { askId: askId! , choice: 'start' }), 403, 'session_required');
    await refused(answerAsk(as(a, b.userId), { askId: askId!, choice: 'start' }), 403, 'session_required');
    await refused(answerAsk(as(a), { askId: askId!, choice: 'merge' }), 422, 'invalid_choice');
    expect(await one(`SELECT state FROM decision_asks WHERE id = $1`, [askId])).toEqual({ state: 'open' });
    expect([await advances(wi), (await admin.query(`SELECT 1 FROM decision_receipts WHERE work_item_id = $1`, [wi])).rows]).toEqual([[], []]);
  });

  it('another tenant cannot answer, raise for or read the ask or its gate row', async () => {
    const wi = await item(a);
    const { askId } = await raise(a, wi);
    await refused(answerAsk(as(b), { askId: askId!, choice: 'start' }), 404, 'not_found');
    await expect(raise(b, wi)).rejects.toMatchObject({ code: '23503' });
    const seen = await admin.query(`SELECT 1 FROM start_gate WHERE work_item_id = $1`, [wi]);
    expect(seen.rows).toHaveLength(1);
    const c = await appPool.connect();
    let asB: unknown[];
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.account_id', $1, true)`, [b.accountId]);
      asB = (await c.query(`SELECT 1 FROM start_gate WHERE work_item_id = $1`, [wi])).rows;
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
    expect(asB).toEqual([]);
    expect(await one(`SELECT state FROM decision_asks WHERE id = $1`, [askId])).toEqual({ state: 'open' });
  });

  it('platform_ops and app_user cannot call any of the four functions', async () => {
    const wi = await item(a);
    const calls = [
      [`SELECT * FROM start_gate_claim($1::uuid, 'start_work_small', 'cautious', 0, 'asked')`, [wi]],
      [`SELECT start_gate_attach($1::uuid, $1::uuid, NULL)`, [wi]],
      [`SELECT start_receipt_write($1::uuid, 'start_work_small', 'start', 'wait_for_approval', 0, 1)`, [wi]],
      [`SELECT start_ask_answer($1::uuid, 'start', $1::uuid)`, [wi]],
    ] as const;
    for (const pool of [opsPool, appPool]) {
      for (const [sql, args] of calls) {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          await c.query(`SELECT set_config('app.account_id', $1, true)`, [a.accountId]);
          await expect(c.query(sql, [...args])).rejects.toMatchObject({ code: '42501' });
        } finally {
          await c.query('ROLLBACK');
          c.release();
        }
      }
    }
    expect(await gateOf(wi)).toBeUndefined();
  });

  it('nobody but the definers can write a gate row, a decided row never changes, and an incomplete row cannot commit', async () => {
    const wi = await item(a);
    await expect(appPool.query(`INSERT INTO start_gate (account_id, work_item_id, decision_type, preset, dial_version, outcome) VALUES ($1, $2, 'start_work_small', 'cautious', 0, 'asked')`, [a.accountId, wi])).rejects.toMatchObject({ code: '42501' });
    const { askId } = await raise(a, wi);
    const res = await answerAsk(as(a), { askId: askId!, choice: 'hold' });
    await expect(admin.query(`UPDATE start_gate SET outcome = 'started' WHERE work_item_id = $1`, [wi])).rejects.toMatchObject({ message: expect.stringContaining('start_gate_terminal') });
    await expect(admin.query(`UPDATE start_gate SET preset = 'autonomous' WHERE work_item_id = $1`, [wi])).rejects.toMatchObject({ message: expect.stringContaining('start_gate_frozen') });
    expect(res.receiptId).toBeTruthy();
    // A claim whose ask is never attached rolls back at commit.
    await expect(
      receiptPool.connect().then(async (c) => {
        try {
          await c.query('BEGIN');
          await c.query(`SELECT set_config('app.account_id', $1, true)`, [a.accountId]);
          await c.query(`SELECT * FROM start_gate_claim($1::uuid, 'start_work_doc', 'cautious', 0, 'asked')`, [wi]);
          await c.query('COMMIT');
        } catch (e) {
          await c.query('ROLLBACK');
          throw e;
        } finally {
          c.release();
        }
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('start_gate_incomplete') });
    expect(await gateOf(wi, 'start_work_doc')).toBeUndefined();
  });

  it('a start ask raised for a class 3 type is answerable the same way; a ask with no run and no gate row is still ask_no_run', async () => {
    const wi = await item(a);
    const { askId } = await raise(a, wi, 'start_parent_item');
    const res = await answerAsk(as(a), { askId: askId!, choice: 'start' });
    expect(await one(`SELECT class, actor FROM decision_receipts WHERE id = $1`, [res.receiptId])).toEqual({ class: 'human_in_the_loop', actor: a.userId });
    expect(await advances(wi)).toHaveLength(1);

    const plain = await admin.query<{ id: string }>(
      `INSERT INTO decision_asks (account_id, repo_id, work_item_id, decision_type, options, proposed, rationale, input_trust_classes, answer_due_at, timeout_outcome)
       VALUES ($1, $2, $3, 'start_work_small', '[{"id":"start","label":"Start"},{"id":"hold","label":"Hold"}]', 'start', 'x', '[]', now() + interval '1 day', 'stop_and_flag') RETURNING id`,
      [a.accountId, a.repoId, wi],
    );
    await refused(answerAsk(as(a), { askId: plain.rows[0]!.id, choice: 'start' }), 409, 'ask_no_run');
  });

  describe('start receipts without a question (recordStartReceipt)', () => {
    it('the dial records a class 2 start as policy, once per pair', async () => {
      const wi = await item(a);
      const first = await recordStartReceipt(gateCtx(a), { workItemId: wi, decisionType: 'start_work_bug', preset: 'balanced' });
      expect(first).toMatchObject({ outcome: 'started', replayed: false, askId: null });
      expect(await one(`SELECT * FROM decision_receipts WHERE id = $1`, [first.receiptId])).toMatchObject({ run_id: null, actor: 'policy', chosen: 'start', class: 'human_over_the_loop' });
      expect(await gateOf(wi, 'start_work_bug')).toMatchObject({ outcome: 'started', preset: 'balanced', decided_by: 'policy', receipt_id: first.receiptId });
      expect(await recordStartReceipt(gateCtx(a), { workItemId: wi, decisionType: 'start_work_bug', preset: 'balanced' })).toMatchObject({ gateId: first.gateId, receiptId: first.receiptId, replayed: true });
      expect((await admin.query(`SELECT 1 FROM decision_receipts WHERE work_item_id = $1`, [wi])).rows).toHaveLength(1);
    });

    it('a person\'s click on a class 3 start has the person as actor; the dial cannot record one', async () => {
      const wi = await item(a);
      await expect(recordStartReceipt(gateCtx(a), { workItemId: wi, decisionType: 'start_parent_item', preset: 'autonomous' })).rejects.toMatchObject({ code: '42501' });
      const click = await recordStartReceipt({ ...gateCtx(a), userId: aAdmin }, { workItemId: wi, decisionType: 'start_parent_item', preset: 'autonomous' });
      expect(await one(`SELECT class, actor FROM decision_receipts WHERE id = $1`, [click.receiptId])).toEqual({ class: 'human_in_the_loop', actor: aAdmin });
      await expect(recordStartReceipt({ ...gateCtx(a), userId: aMember }, { workItemId: await item(a), decisionType: 'start_work_doc', preset: 'balanced' })).rejects.toMatchObject({ code: '42501' });
    });

    it('a work item of another account is refused', async () => {
      await expect(recordStartReceipt(gateCtx(b), { workItemId: await item(a), decisionType: 'start_work_doc', preset: 'balanced' })).rejects.toMatchObject({ code: '23503' });
    });
  });
});
