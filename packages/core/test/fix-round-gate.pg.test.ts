import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { answerAsk } from '../src/decisions/answer.js';
import { approveSubItem } from '../src/decisions/approveSubItem.js';
import { FIX_ASK_HOLD, FIX_ASK_START, gateFixRound, presetOf } from '../src/decisions/fixRoundGate.js';
import { readStartDecision } from '../src/work-items/startDecision.js';
import { withTenant } from '../src/tenancy/withTenant.js';

/**
 * D#483 S5-b2a part 2: the review fix-round gate against a real Postgres, on the receipt pool (app_user + receipt_writer_invoker). Cautious asks once and the
 * answer starts one round; Balanced writes one policy receipt and says so; an item without an approval row and a Spec is not gated; everything is per tenant.
 */
const LOGIN = 'fx_fix_round_gate_core_test';

describe('gateFixRound (D#483 S5-b2a part 2)', () => {
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

  interface Fixture { t: SeedRefs; workItemId: string; reviewRun: string; specId: string; approver: string; approvalId: string | null }
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
  async function fixture(o: { approved?: boolean; spec?: boolean; dial?: 'ask' | 'announce' | 'act'; provenance?: string } = {}): Promise<Fixture> {
    const t = await seedAccount(admin, randomUUID());
    const workItemId = (await admin.query<{ id: string }>(
      `INSERT INTO work_items (account_id, repo_id, kind, provenance, title) VALUES ($1, $2, 'issue', $3, 'Fix it') RETURNING id`, [t.accountId, t.repoId, o.provenance ?? 'internal'])).rows[0]!.id;
    const specId = o.spec === false ? '' : await addSpec(t, workItemId, 1);
    const reviewRun = (await admin.query<{ id: string }>(
      `INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status) VALUES ($1, $2, 'code-reviewer', 'local', 'succeeded') RETURNING id`, [t.accountId, workItemId])).rows[0]!.id;
    const approver = await addUser(t, 'admin');
    let approvalId: string | null = null;
    if (o.approved !== false && o.spec !== false) {
      approvalId = (await withTenant(appPool, t.accountId, approver, (c) => c.query<{ o_approval_id: string }>(`SELECT * FROM work_item_approval_record($1, 'work_item_approve')`, [workItemId]))).rows[0]!.o_approval_id;
    }
    if (o.dial) await admin.query(`INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, version, changed_by) VALUES ($1, $2, 'launch_sub_item', $3, 1, $4)`, [t.accountId, t.repoId, o.dial, approver]);
    return { t, workItemId, reviewRun, specId, approver, approvalId };
  }
  const gate = (f: Fixture, person: string | null = null, accountId = f.t.accountId) => gateFixRound({ pool: receiptPool, accountId }, { workItemId: f.workItemId, personUserId: person });
  const receiptsOf = async (f: Fixture) => (await admin.query('SELECT * FROM decision_receipts WHERE work_item_id = $1 ORDER BY created_at', [f.workItemId])).rows;
  const asksOf = async (f: Fixture) => (await admin.query(`SELECT * FROM decision_asks WHERE work_item_id = $1 AND decision_type = 'launch_sub_item' ORDER BY raised_at`, [f.workItemId])).rows;
  const advances = async (f: Fixture) => (await admin.query(`SELECT * FROM run_action_requests WHERE kind = 'advance_work_item' AND target_id = $1 AND idempotency_key LIKE 'subitem:%'`, [f.workItemId])).rows;
  const sentenceOf = (f: Fixture) => withTenant(receiptPool, f.t.accountId, async (c) => (await readStartDecision(c, f.workItemId))?.sentence ?? null);
  const startRound = (f: Fixture, n: number) => admin.query(`INSERT INTO work_item_driver_events (account_id, work_item_id, kind, dedupe_key) VALUES ($1, $2, 'fix_round_started', $3)`, [f.t.accountId, f.workItemId, `r${n}`]);
  const answer = (f: Fixture, askId: string, choice: string, userId = f.approver) => answerAsk({ pool: receiptPool, principal: { accountId: f.t.accountId, userId } }, { askId, choice });

  describe('the dial', () => {
    it('only the absence of a row is Balanced: a disposition this build cannot read is Cautious, never a launch', () => {
      expect(presetOf(null)).toBe('balanced');
      expect(presetOf(undefined)).toBe('balanced');
      expect([presetOf('ask'), presetOf('announce'), presetOf('act')]).toEqual(['cautious', 'balanced', 'autonomous']);
      for (const odd of ['', 'ACT', 'launch', 'proceed', 'banana', '__proto__', 'constructor', 'toString']) expect(presetOf(odd)).toBe('cautious');
    });
  });

  describe('not gated', () => {
    it('an item with no approval row, or no Spec, goes on and records nothing (rows-only gate, grandfathered)', async () => {
      for (const f of [await fixture({ approved: false, dial: 'ask' }), await fixture({ spec: false, dial: 'ask' })]) {
        expect(await gate(f)).toMatchObject({ proceed: true, how: 'not_gated' });
        expect(await receiptsOf(f)).toHaveLength(0);
        expect(await asksOf(f)).toHaveLength(0);
      }
    });
  });

  describe('Balanced and Autonomous', () => {
    it('with NO dial row (Balanced) it writes one keyed policy receipt that names the approval, says so once, and a replay writes nothing', async () => {
      const f = await fixture();
      const first = await gate(f);
      expect(first).toEqual({ proceed: true, how: 'policy_receipt', key: 'fix-1', announce: true });
      expect(await receiptsOf(f)).toMatchObject([{ actor: 'policy', chosen: 'announce', sub_item_key: 'fix-1', spec_version_id: f.specId, approval_id: f.approvalId, run_id: f.reviewRun, class: 'human_over_the_loop' }]);
      const again = await gate(f);
      expect(again).toMatchObject({ proceed: true, how: 'already_decided', announce: false });
      expect(await receiptsOf(f)).toHaveLength(1);
      expect(await asksOf(f)).toHaveLength(0);
      expect(await sentenceOf(f)).toBe('Fix round 1 started automatically under your Balanced setting. No one had to answer.');
    });

    it('an Autonomous row launches with chosen "launch" and no notice; Balanced row says so', async () => {
      const act = await fixture({ dial: 'act' });
      expect(await gate(act)).toMatchObject({ proceed: true, how: 'policy_receipt', announce: false });
      expect(await receiptsOf(act)).toMatchObject([{ chosen: 'launch', actor: 'policy', dial_version: 1 }]);
      const ann = await fixture({ dial: 'announce' });
      expect(await gate(ann)).toMatchObject({ announce: true });
    });

    it('one round per number: the next round has its own key and receipt, and the receipt counts only under the current Spec version', async () => {
      const f = await fixture();
      await gate(f);
      await startRound(f, 1);
      expect(await gate(f)).toMatchObject({ how: 'policy_receipt', key: 'fix-2' });
      expect((await receiptsOf(f)).map((r) => r.sub_item_key)).toEqual(['fix-1', 'fix-2']);
    });
  });

  describe('a person-filed workflow', () => {
    it('still starts a round on Balanced and on Autonomous: the policy receipt is written without the person\'s session (the whole workflow is person-filed)', async () => {
      const bal = await fixture();
      expect(await gate(bal, bal.approver)).toMatchObject({ proceed: true, how: 'policy_receipt', announce: true });
      expect(await receiptsOf(bal)).toMatchObject([{ actor: 'policy', chosen: 'announce', sub_item_key: 'fix-1' }]);
      const act = await fixture({ dial: 'act' });
      expect(await gate(act, act.approver)).toMatchObject({ proceed: true, how: 'policy_receipt', announce: false });
      expect(await receiptsOf(act)).toMatchObject([{ actor: 'policy', chosen: 'launch' }]);
    });
  });

  describe('Cautious', () => {
    it('raises ONE ask for the round in Needs you, keyed, on the review run, and a replay finds it; nothing starts', async () => {
      const f = await fixture({ dial: 'ask' });
      const first = await gate(f);
      expect(first).toMatchObject({ proceed: false, reason: 'asked', key: 'fix-1' });
      const again = await gate(f);
      expect(again).toMatchObject({ proceed: false, reason: 'asked', askId: (first as { askId: string }).askId });
      const asks = await asksOf(f);
      expect(asks).toHaveLength(1);
      expect(asks[0]).toMatchObject({ sub_item_key: 'fix-1', run_id: f.reviewRun, state: 'open', proposed: FIX_ASK_START, decision_type: 'launch_sub_item' });
      expect(await receiptsOf(f)).toHaveLength(0);
      expect(await sentenceOf(f)).toBe('Waiting for an owner or admin to answer in Needs you: your setting asks before fix round 1 starts.');
    });

    it('two gates at once raise one ask (the live-ask index backs the read)', async () => {
      const f = await fixture({ dial: 'ask' });
      const rs = await Promise.all([gate(f), gate(f), gate(f)]);
      expect(rs.every((r) => !r.proceed && r.reason === 'asked')).toBe(true);
      expect(await asksOf(f)).toHaveLength(1);
    });

    it('starting the ask in Needs you is the approval: a person receipt for the key, the ask closed, ONE advance filed, the gate then goes on, and only that round', async () => {
      const f = await fixture({ dial: 'ask' });
      const asked = (await gate(f)) as { askId: string };
      const done = await answer(f, asked.askId, FIX_ASK_START);
      expect(done.answeredOption).toBe(FIX_ASK_START);
      expect(await receiptsOf(f)).toMatchObject([{ actor: f.approver, sub_item_key: 'fix-1', spec_version_id: f.specId }]);
      expect((await asksOf(f))[0]).toMatchObject({ state: 'withdrawn' });
      expect(await advances(f)).toHaveLength(1);
      expect(await gate(f)).toMatchObject({ proceed: true, how: 'already_decided' });
      // A second answer is refused and files nothing more.
      await expect(answer(f, asked.askId, FIX_ASK_START)).rejects.toMatchObject({ code: 'already_answered' });
      expect(await advances(f)).toHaveLength(1);
      expect(await receiptsOf(f)).toHaveLength(1);
      // The round started: the next round asks again, the answer did not carry over.
      await startRound(f, 1);
      expect(await gate(f)).toMatchObject({ proceed: false, reason: 'asked', key: 'fix-2' });
      expect(await asksOf(f)).toHaveLength(2);
    });

    it('the card Approve and the Needs-you answer are one decision: whichever comes second finds the first', async () => {
      const f = await fixture({ dial: 'ask' });
      const asked = (await gate(f)) as { askId: string };
      const viaCard = await approveSubItem({ pool: receiptPool, principal: { accountId: f.t.accountId, userId: f.approver } }, { workItemId: f.workItemId, key: 'fix-1' });
      expect(viaCard).toMatchObject({ withdrawnAsks: 1 });
      expect(viaCard.advanceActionId).not.toBeNull();
      await expect(answer(f, asked.askId, FIX_ASK_START)).rejects.toMatchObject({ code: 'already_answered' });
      expect(await advances(f)).toHaveLength(1);
      // An approval nobody waited for files no advance.
      const g = await fixture({ dial: 'ask' });
      const pre = await approveSubItem({ pool: receiptPool, principal: { accountId: g.t.accountId, userId: g.approver } }, { workItemId: g.workItemId, key: 'fix-1' });
      expect(pre.advanceActionId).toBeNull();
      expect(await advances(g)).toHaveLength(0);
    });

    it('holding it records a hold and files no resume or advance; an UNATTENDED re-entry asks again, a PERSON-filed one is the answer', async () => {
      const f = await fixture({ dial: 'ask' });
      const asked = (await gate(f)) as { askId: string };
      await answer(f, asked.askId, FIX_ASK_HOLD);
      expect(await advances(f)).toHaveLength(0);
      expect((await admin.query(`SELECT count(*)::int AS n FROM run_action_requests WHERE kind = 'resume_decision' AND target_id = $1`, [asked.askId])).rows[0].n).toBe(0);
      expect(await receiptsOf(f)).toMatchObject([{ chosen: FIX_ASK_HOLD, sub_item_key: null }]);
      const unattended = await gate(f);
      expect(unattended).toMatchObject({ proceed: false, reason: 'asked' });
      expect((unattended as { askId: string }).askId).not.toBe(asked.askId);
      expect(await asksOf(f)).toHaveLength(2);
      // A person's advance after a hold: the click is the answer. The newest ask is open; the hold on this key still stands from the first.
      const person = await gate(f, f.approver);
      expect(person).toMatchObject({ proceed: true, how: 'person_answer', key: 'fix-1' });
      expect((await receiptsOf(f)).filter((r) => r.sub_item_key === 'fix-1')).toMatchObject([{ actor: f.approver }]);
      expect(await gate(f)).toMatchObject({ proceed: true, how: 'already_decided' });
      // The re-raised ask was closed by the person's answer: a later Start on it is refused and files nothing.
      expect((await asksOf(f)).map((a) => a.state)).toEqual(['answered', 'withdrawn']);
      await expect(answer(f, (unattended as { askId: string }).askId, FIX_ASK_START)).rejects.toMatchObject({ code: 'already_answered' });
      expect(await advances(f)).toHaveLength(0);
    });

    it('a held round shows on the card as held until it starts', async () => {
      const f = await fixture({ dial: 'ask' });
      const asked = (await gate(f)) as { askId: string };
      await answer(f, asked.askId, FIX_ASK_HOLD);
      expect(await sentenceOf(f)).toBe('Fix round 1 is held. It starts when an owner or admin starts it.');
      await gate(f, f.approver);
      expect(await sentenceOf(f)).toContain('Fix round 1 approved by');
    });

    it('a plain member\'s advance after a hold is refused and logged with its code, and starts nothing', async () => {
      const f = await fixture({ dial: 'ask' });
      const asked = (await gate(f)) as { askId: string };
      await answer(f, asked.askId, FIX_ASK_HOLD);
      const member = await addUser(f.t, 'member');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        expect(await gate(f, member)).toMatchObject({ proceed: false, reason: 'blocked', blockedBy: 'fix_launch_forbidden' });
        expect(warn).toHaveBeenCalledWith(JSON.stringify({ event: 'fix_gate.person_refused', code: '42501' }));
      } finally { warn.mockRestore(); }
      expect((await receiptsOf(f)).filter((r) => r.sub_item_key !== null)).toHaveLength(0);
    });

    it('a person-filed advance with NO hold on the round is not a bypass: Cautious still asks', async () => {
      const f = await fixture({ dial: 'ask' });
      expect(await gate(f, f.approver)).toMatchObject({ proceed: false, reason: 'asked' });
      expect(await receiptsOf(f)).toHaveLength(0);
    });

    it('a plain member cannot answer, and a token cannot: nothing is written', async () => {
      const f = await fixture({ dial: 'ask' });
      const asked = (await gate(f)) as { askId: string };
      const member = await addUser(f.t, 'member');
      await expect(answer(f, asked.askId, FIX_ASK_START, member)).rejects.toMatchObject({ code: 'forbidden' });
      await expect(answerAsk({ pool: receiptPool, principal: { accountId: f.t.accountId, userId: f.approver, tokenId: randomUUID() } }, { askId: asked.askId, choice: FIX_ASK_START })).rejects.toMatchObject({ code: 'session_required' });
      expect(await receiptsOf(f)).toHaveLength(0);
      expect(await advances(f)).toHaveLength(0);
      expect((await asksOf(f))[0]).toMatchObject({ state: 'open' });
    });
  });

  describe('fail closed', () => {
    it('a Spec the approval does not name stops the round with no ask and no receipt (approve again first)', async () => {
      const f = await fixture({ dial: 'act' });
      await addSpec(f.t, f.workItemId, 2);
      expect(await gate(f)).toMatchObject({ proceed: false, reason: 'blocked', blockedBy: 'respec_needs_approval' });
      expect(await receiptsOf(f)).toHaveLength(0);
      expect(await asksOf(f)).toHaveLength(0);
      // A receipt written under the old Spec does not carry over to the new one.
      const g = await fixture();
      await gate(g);
      await addSpec(g.t, g.workItemId, 2);
      expect(await gate(g)).toMatchObject({ proceed: false, blockedBy: 'respec_needs_approval' });
    });

    it('an approval row that names no Spec, with a Spec on the item now, stops (spec_version_unknown)', async () => {
      const f = await fixture({ spec: false });
      await admin.query('INSERT INTO work_item_approvals (account_id, work_item_id, approved_by, source) VALUES ($1, $2, $3, $4)', [f.t.accountId, f.workItemId, f.approver, 'work_item_approve']);
      await addSpec(f.t, f.workItemId, 1);
      expect(await gate(f)).toMatchObject({ proceed: false, reason: 'blocked', blockedBy: 'spec_version_unknown' });
    });

    it('an item that is not internal never starts, whatever the dial says', async () => {
      const ext = await fixture({ dial: 'act', provenance: 'external' });
      expect(await gate(ext)).toMatchObject({ proceed: false, reason: 'blocked', blockedBy: 'untrusted_work_creation' });
      expect(await receiptsOf(ext)).toHaveLength(0);
    });

    it('no succeeded verdict run to hang the decision on: blocked, not started', async () => {
      const f = await fixture({ dial: 'act' });
      await admin.query(`UPDATE agent_runs SET status = 'failed' WHERE id = $1`, [f.reviewRun]);
      expect(await gate(f)).toMatchObject({ proceed: false, reason: 'blocked', blockedBy: 'no_anchor_run' });
      const g = await fixture({ dial: 'ask' });
      await admin.query(`UPDATE agent_runs SET status = 'failed' WHERE id = $1`, [g.reviewRun]);
      expect(await gate(g)).toMatchObject({ proceed: false, reason: 'blocked', blockedBy: 'no_anchor_run' });
      expect(await asksOf(g)).toHaveLength(0);
    });

    it('the database refuses a dial row this build cannot read, so an unknown disposition cannot reach the gate', async () => {
      const f = await fixture();
      await expect(admin.query(`INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, version, changed_by) VALUES ($1, $2, 'launch_sub_item', 'banana', 1, $3)`, [f.t.accountId, f.t.repoId, f.approver])).rejects.toBeTruthy();
    });
  });

  describe('tenant scoping and the definers', () => {
    it('another account cannot gate, approve or answer for this item: an unknown item is blocked, not started', async () => {
      const f = await fixture({ dial: 'ask' });
      const other = await fixture({ dial: 'act' });
      expect(await gate(f, null, other.t.accountId)).toMatchObject({ proceed: false, reason: 'blocked' });
      expect(await receiptsOf(f)).toHaveLength(0);
      expect(await asksOf(f)).toHaveLength(0);
      const asked = (await gate(f)) as { askId: string };
      await expect(answerAsk({ pool: receiptPool, principal: { accountId: other.t.accountId, userId: other.approver } }, { askId: asked.askId, choice: FIX_ASK_START })).rejects.toMatchObject({ code: 'not_found' });
    });

    it('sub_item_policy_receipt_write refuses a session with a person or a token, and writes nothing for a Spec that is not current', async () => {
      const f = await fixture();
      const write = (c: PoolClient, spec: string) =>
        c.query(`SELECT * FROM sub_item_policy_receipt_write($1, 'fix-1', $2, $3, $4, 'launch', 0, 1)`, [f.workItemId, spec, f.reviewRun, f.approvalId]);
      const call = (userId: string | undefined, spec = f.specId) =>
        userId ? withTenant(receiptPool, f.t.accountId, userId, undefined, (c) => write(c, spec)) : withTenant(receiptPool, f.t.accountId, (c) => write(c, spec));
      await expect(call(f.approver)).rejects.toMatchObject({ code: '42501' });
      await expect(call(undefined, randomUUID())).rejects.toMatchObject({ code: '22023' });
      expect(await receiptsOf(f)).toHaveLength(0);
      await call(undefined);
      expect(await receiptsOf(f)).toHaveLength(1);
    });

    it('sub_item_policy_receipt_write refuses an approval that is another item\'s, one for an older Spec, a missing one, and any launch under a dial that asks', async () => {
      const f = await fixture();
      const other = await fixture();
      const write = (x: Fixture, approvalId: string | null, spec = x.specId, run = x.reviewRun) =>
        withTenant(receiptPool, x.t.accountId, (c) => c.query(`SELECT * FROM sub_item_policy_receipt_write($1, 'fix-1', $2, $3, $4, 'launch', 0, 1)`, [x.workItemId, spec, run, approvalId]));
      // Another item's approval: a different tenant's row is invisible, and a same-account item's row is not THIS item's newest.
      await expect(write(f, other.approvalId)).rejects.toMatchObject({ code: '22023' });
      const sibling = (await admin.query<{ id: string }>(`INSERT INTO work_items (account_id, repo_id, kind, provenance, title) VALUES ($1, $2, 'issue', 'internal', 'Sibling') RETURNING id`, [f.t.accountId, f.t.repoId])).rows[0]!.id;
      const siblingSpec = await addSpec(f.t, sibling, 1);
      const siblingApproval = (await withTenant(appPool, f.t.accountId, f.approver, (c) => c.query<{ o_approval_id: string }>(`SELECT * FROM work_item_approval_record($1, 'work_item_approve')`, [sibling]))).rows[0]!.o_approval_id;
      await expect(write(f, siblingApproval)).rejects.toMatchObject({ code: '22023' });
      await expect(write(f, null)).rejects.toMatchObject({ code: '22023' });
      expect(siblingSpec).not.toBe(f.specId);
      // An approval for an older Spec: a newer Spec exists and the item was approved again; the first approval is not the newest.
      const g = await fixture();
      const v2 = await addSpec(g.t, g.workItemId, 2);
      await withTenant(appPool, g.t.accountId, g.approver, (c) => c.query(`SELECT * FROM work_item_approval_record($1, 'reapprove_after_respec')`, [g.workItemId]));
      await expect(write(g, g.approvalId, g.specId)).rejects.toMatchObject({ code: '22023' });
      await expect(write(g, g.approvalId, v2)).rejects.toMatchObject({ code: '22023' });
      expect(await receiptsOf(f)).toHaveLength(0);
      expect(await receiptsOf(g)).toHaveLength(0);
      // The right approval under the right Spec writes; a dial that asks refuses.
      expect((await write(f, f.approvalId)).rows).toHaveLength(1);
      const ask = await fixture({ dial: 'ask' });
      await expect(write(ask, ask.approvalId)).rejects.toMatchObject({ code: '42501' });
      expect(await receiptsOf(ask)).toHaveLength(0);
    });

    it('sub_item_ask_key keys only a waiting launch_sub_item ask with no key, in the caller\'s own tenant', async () => {
      const f = await fixture();
      const other = await fixture();
      const raise = (x: Fixture, type: string) => withTenant(receiptPool, x.t.accountId, async (c) => (await c.query<{ id: string }>(
        `SELECT decision_ask_raise('human_over_the_loop', $1::text, $2::uuid, $3::uuid, '[{"id":"a","label":"A"},{"id":"b","label":"B"}]'::jsonb, 'a', 'because', '["trusted"]'::jsonb, 60, 'stop_and_flag', 0) AS id`,
        [type, x.workItemId, x.reviewRun])).rows[0]!.id);
      const key = (x: Fixture, id: string, k = 'fix-1') => withTenant(receiptPool, x.t.accountId, async (c) => (await c.query<{ m: boolean }>('SELECT sub_item_ask_key($1, $2) AS m', [id, k])).rows[0]!.m);
      const ask = await raise(f, 'launch_sub_item');
      expect(await key(other, ask)).toBe(false);
      expect(await key(f, await raise(f, 'spend_past_envelope'))).toBe(false);
      expect(await key(f, ask)).toBe(true);
      expect(await key(f, ask, 'fix-2')).toBe(false);
    });
  });
});
