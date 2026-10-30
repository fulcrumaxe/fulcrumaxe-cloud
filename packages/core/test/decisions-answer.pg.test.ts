import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RECEIPT_HOOK_DEADLINE_MS } from '../src/decisions/receiptHook.js';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { raiseAsk, type RaiseAskInput } from '@fx/db/src/decisionAsks.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { withTenant } from '../src/tenancy/withTenant.js';
import { AskAnswerError, answerAsk, listPendingAsks } from '../src/decisions/index.js';

/** DP11b (D#7 DP-C9): answerAsk and listPendingAsks against a real Postgres, on the receipt pool (app_user + receipt_writer_invoker). */
const INVOKER_LOGIN = 'fx_receipt_invoker_test';
const OPTIONS = [{ id: 'apply', label: 'Apply the change' }, { id: 'skip', label: 'Skip it' }];

describe('answerAsk (DP11b)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let receiptPool: Pool;
  let appPool: Pool;
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
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    aAdmin = await addUser(a.accountId, 'admin');
    aMember = await addUser(a.accountId, 'member');
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), receiptPool.end(), appPool.end()]);
  });

  const as = (t: SeedRefs, userId: string = t.userId) => ({ pool: receiptPool, principal: { accountId: t.accountId, userId } });
  const raise = (t: SeedRefs, over: Partial<RaiseAskInput> = {}): Promise<string> =>
    withTenant(receiptPool, t.accountId, (c) =>
      raiseAsk(c, {
        class: 'human_over_the_loop', decisionType: 'test_strategy_choice', workItemId: t.workItemId, runId: t.runId, options: OPTIONS,
        proposed: 'apply', rationale: 'because', quotedInputs: [{ trust: 'trusted', storedBody: 'x' }], ...over,
      }));
  const readAsk = async (id: string) => (await admin.query(`SELECT * FROM decision_asks WHERE id = $1`, [id])).rows[0];
  const count = async (sql: string, t: SeedRefs) => (await admin.query(sql, [t.accountId])).rows[0].n as number;
  const nReceipts = (t: SeedRefs) => count(`SELECT count(*)::int AS n FROM decision_receipts WHERE account_id = $1`, t);
  const nEvents = (t: SeedRefs) => count(`SELECT count(*)::int AS n FROM domain_events WHERE account_id = $1 AND type = 'decision.ask_answered'`, t);
  const nActions = (t: SeedRefs) => count(`SELECT count(*)::int AS n FROM run_action_requests WHERE account_id = $1`, t);
  const refused = (p: Promise<unknown>, status: number, code: string) => expect(p).rejects.toMatchObject({ name: 'AskAnswerError', status, code });
  const receiptOf = async (id: string) => (await admin.query(`SELECT * FROM decision_receipts WHERE id = $1`, [id])).rows[0];

  it('writes the receipt, answers the ask and links them; one resume request (DP11c), one event with ids only', async () => {
    const id = await raise(a);
    const [r0, e0, q0] = [await nReceipts(a), await nEvents(a), await nActions(a)];
    const res = await answerAsk(as(a), { askId: id, choice: 'skip' });
    expect(res).toMatchObject({ askId: id, answeredOption: 'skip' });
    expect(await readAsk(id)).toMatchObject({ state: 'answered', answered_option: 'skip', answered_by: a.userId, receipt_id: res.receiptId });
    expect(await receiptOf(res.receiptId)).toMatchObject({
      account_id: a.accountId, run_id: a.runId, work_item_id: a.workItemId, decision_type: 'test_strategy_choice', class: 'human_over_the_loop',
      chosen: 'skip', rejected_alternative: 'apply', dial_version: 0, actor: a.userId, input_trust_classes: ['trusted'],
    });
    expect([await nReceipts(a), await nEvents(a), await nActions(a)]).toEqual([r0 + 1, e0 + 1, q0 + 1]);
    const ev = (await admin.query(`SELECT payload FROM domain_events WHERE account_id = $1 AND type = 'decision.ask_answered' AND subject_id = $2`, [a.accountId, id])).rows[0].payload;
    expect(ev).toEqual({ ask_id: id, work_item_id: a.workItemId, run_id: a.runId, receipt_id: res.receiptId, decision_type: 'test_strategy_choice', answered_option: 'skip' });
  });

  describe('the resume request (D#7 DP11c, DP-C9 section 5 criterion 6)', () => {
    const requestsOf = async (askId: string) => (await admin.query(`SELECT * FROM run_action_requests WHERE kind = 'resume_decision' AND target_id = $1`, [askId])).rows;

    it('is the answering person\'s own request, keyed by the ask, made in the answer\'s transaction; a replayed answer makes no second one', async () => {
      const id = await raise(a);
      await answerAsk(as(a, aAdmin), { askId: id, choice: 'skip' });
      const rows = await requestsOf(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ requested_by: `session:${aAdmin}`, principal_kind: 'session', idempotency_key: `ask:${id}`, state: 'accepted', resume_halt_epoch: 0 });
      await refused(answerAsk(as(a), { askId: id, choice: 'skip' }), 409, 'already_answered');
      expect(await requestsOf(id)).toHaveLength(1);
    });

    it('deny asks for a resume too (the resumed role is told it was refused)', async () => {
      const id = await raise(a);
      await answerAsk(as(a), { askId: id, choice: 'deny' });
      expect(await requestsOf(id)).toHaveLength(1);
    });

    it('a refused answer makes no request, and a request that cannot be made rolls the whole answer back (no receipt, ask still open)', async () => {
      const id = await raise(a);
      await refused(answerAsk(as(a, aMember), { askId: id, choice: 'skip' }), 403, 'forbidden');
      await refused(answerAsk(as(a), { askId: id, choice: 'merge' }), 422, 'invalid_choice');
      expect(await requestsOf(id)).toEqual([]);
      // Force the request to fail: a request for this ask already exists under another requester with a different hash for the same key.
      await admin.query(`INSERT INTO run_action_requests (account_id, kind, target_id, requested_by, principal_kind, idempotency_key, request_hash, resume_halt_epoch)
                         VALUES ($1, 'resume_decision', $2, $3, 'session', $4, 'other', 0)`, [a.accountId, randomUUID(), `session:${a.userId}`, `ask:${id}`]);
      const before = await nReceipts(a);
      await expect(answerAsk(as(a), { askId: id, choice: 'skip' })).rejects.toMatchObject({ code: '22023' });
      expect(await nReceipts(a)).toBe(before);
      expect((await readAsk(id)).state).toBe('open');
    });

    it('D#7 DP6a-WIRING: a receipt hook that never resolves holds the answer for the deadline at most; the answer is committed and the resume is announced', async () => {
      const sent: unknown[] = [];
      const signal = { signal: async (m: unknown) => void sent.push(m) };
      const hook = vi.fn(() => new Promise<void>(() => undefined));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const id = await raise(a);
      const t0 = Date.now();
      await expect(answerAsk({ ...as(a), signal, afterReceipt: hook }, { askId: id, choice: 'skip' })).resolves.toMatchObject({ askId: id });
      expect(Date.now() - t0).toBeLessThan(RECEIPT_HOOK_DEADLINE_MS + 4000);
      warn.mockRestore();
      expect(hook).toHaveBeenCalledTimes(1);
      expect((await readAsk(id)).state).toBe('answered');
      expect(sent).toHaveLength(1);
    }, 20_000);

    it('kicks the run-action workflow after the commit, for a new request only; a signal that fails changes nothing', async () => {
      const sent: unknown[] = [];
      const signal = { signal: async (m: unknown) => void sent.push(m) };
      const id = await raise(a);
      await answerAsk({ ...as(a), signal }, { askId: id, choice: 'skip' });
      const [req] = await requestsOf(id);
      expect(sent).toEqual([{ actionId: req.id, accountId: a.accountId, kind: 'resume_decision' }]);
      const boom = { signal: async () => { throw new Error('queue down'); } };
      const id2 = await raise(a);
      await expect(answerAsk({ ...as(a), signal: boom }, { askId: id2, choice: 'skip' })).resolves.toMatchObject({ askId: id2 });
      expect(await requestsOf(id2)).toHaveLength(1);
    });
  });

  it('choosing the proposal rejects deny; choosing deny rejects the proposal', async () => {
    const rp = await answerAsk(as(a, aAdmin), { askId: await raise(a), choice: 'apply' });
    const rd = await answerAsk(as(a), { askId: await raise(a), choice: 'deny' });
    expect(await receiptOf(rp.receiptId)).toMatchObject({ chosen: 'apply', rejected_alternative: 'deny', actor: aAdmin });
    expect(await receiptOf(rd.receiptId)).toMatchObject({ chosen: 'deny', rejected_alternative: 'apply' });
  });

  it('dialVersion is the current decision_settings version (3) when the repo has a row, and 0 for a work item with no repo', async () => {
    for (let v = 1; v <= 3; v++) {
      await admin.query(`INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, version, changed_by) VALUES ($1, $2, 'test_strategy_choice', 'ask', $3, $4)`,
        [b.accountId, b.repoId, v, b.userId]);
    }
    const withRow = await answerAsk(as(b), { askId: await raise(b), choice: 'skip' });
    expect((await receiptOf(withRow.receiptId)).dial_version).toBe(3);

    const [wi, run] = [randomUUID(), randomUUID()];
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance) VALUES ($1, $2, NULL, 'feature', 'internal')`, [wi, a.accountId]);
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'executor', 'local', 'running')`, [run, a.accountId, wi]);
    const noRepo = await answerAsk(as(a), { askId: await raise(a, { workItemId: wi, runId: run }), choice: 'skip' });
    expect(await receiptOf(noRepo.receiptId)).toMatchObject({ dial_version: 0, run_id: run });
  });

  it('an ask with no run is 409 ask_no_run and writes nothing', async () => {
    const id = await raise(a, { runId: null });
    const [r0, e0] = [await nReceipts(a), await nEvents(a)];
    await refused(answerAsk(as(a), { askId: id, choice: 'skip' }), 409, 'ask_no_run');
    expect([await nReceipts(a), await nEvents(a), (await readAsk(id)).state]).toEqual([r0, e0, 'open']);
  });

  it('a token is 403 session_required, a plain member 403 forbidden, an outsider 403 session_required; nothing is written', async () => {
    const id = await raise(a);
    const r0 = await nReceipts(a);
    await refused(answerAsk({ pool: receiptPool, principal: { accountId: a.accountId, userId: a.userId, tokenId: randomUUID() } }, { askId: id, choice: 'skip' }), 403, 'session_required');
    await refused(answerAsk(as(a, aMember), { askId: id, choice: 'skip' }), 403, 'forbidden');
    await refused(answerAsk(as(a, b.userId), { askId: id, choice: 'skip' }), 403, 'session_required');
    expect([await nReceipts(a), (await readAsk(id)).state]).toEqual([r0, 'open']);
  });

  it('a missing, foreign or malformed id gives the same 404', async () => {
    const foreign = await raise(b);
    for (const askId of [randomUUID(), foreign, 'not-a-uuid', '']) await refused(answerAsk(as(a), { askId, choice: 'skip' }), 404, 'not_found');
    expect((await readAsk(foreign)).state).toBe('open');
  });

  it('a second answer is 409 already_answered and writes nothing', async () => {
    const id = await raise(a);
    await answerAsk(as(a), { askId: id, choice: 'skip' });
    const [before, r0, e0] = [await readAsk(id), await nReceipts(a), await nEvents(a)];
    await refused(answerAsk(as(a, aAdmin), { askId: id, choice: 'apply' }), 409, 'already_answered');
    expect([await readAsk(id), await nReceipts(a), await nEvents(a)]).toEqual([before, r0, e0]);
  });

  it('a choice outside the options, or from another ask\'s options, is 422 and writes nothing', async () => {
    const mine = await raise(a);
    await raise(a, { options: [{ id: 'ship', label: 'Ship' }, { id: 'hold', label: 'Hold' }], proposed: 'ship' });
    const r0 = await nReceipts(a);
    for (const choice of ['merge', 'ship', 'Deny', '', undefined as unknown as string]) await refused(answerAsk(as(a), { askId: mine, choice }), 422, 'invalid_choice');
    expect([await nReceipts(a), (await readAsk(mine)).state]).toEqual([r0, 'open']);
  });

  it('50 rounds of two answers at once: exactly one wins, exactly one receipt, the loser changes nothing', async () => {
    for (let i = 0; i < 50; i++) {
      const id = await raise(a);
      const [r0, e0] = [await nReceipts(a), await nEvents(a)];
      const settled = await Promise.allSettled([answerAsk(as(a), { askId: id, choice: 'skip' }), answerAsk(as(a, aAdmin), { askId: id, choice: 'apply' })]);
      const lost = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
      expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect(lost[0]!.reason).toBeInstanceOf(AskAnswerError);
      expect(lost[0]!.reason).toMatchObject({ status: 409, code: 'already_answered' });
      expect([await nReceipts(a), await nEvents(a)]).toEqual([r0 + 1, e0 + 1]);
      const ask = await readAsk(id);
      expect((await receiptOf(ask.receipt_id)).chosen).toBe(ask.answered_option);
    }
  });

  it('listPendingAsks: overdue first, then by due time; answered asks are gone; the limit says when more exist', async () => {
    const t = await seedAccount(admin, randomUUID());
    const win = (answerWindowMinutes: number) => ({ policy: { answerWindowMinutes, onTimeout: 'stop_and_flag' as const } });
    const [x, y, z, done] = [await raise(t, win(180)), await raise(t, win(120)), await raise(t, win(240)), await raise(t, win(60))];
    await admin.query(`UPDATE decision_asks SET state = 'overdue' WHERE id = $1`, [z]);
    await answerAsk(as(t), { askId: done, choice: 'skip' });
    const ctx = { pool: appPool, principal: { accountId: t.accountId, userId: t.userId } };
    const page = await listPendingAsks(ctx);
    expect(page.asks.map((q) => q.id)).toEqual([z, y, x]);
    expect(page.asks[0]).toMatchObject({ state: 'overdue', options: OPTIONS, proposed: 'apply', rationale: 'because', timeoutOutcome: 'stop_and_flag' });
    expect(page.nextCursor).toBeNull();
    const first = await listPendingAsks(ctx, { limit: 2 });
    expect(first.asks.map((q) => q.id)).toEqual([z, y]);
    const rest = await listPendingAsks(ctx, { limit: 2, cursor: first.nextCursor! });
    expect(rest.asks.map((q) => q.id)).toEqual([x]);
    expect(rest.nextCursor).toBeNull();
    expect((await listPendingAsks({ pool: appPool, principal: { accountId: b.accountId, userId: b.userId } })).asks.map((q) => q.id)).not.toContain(x);
  });
});
