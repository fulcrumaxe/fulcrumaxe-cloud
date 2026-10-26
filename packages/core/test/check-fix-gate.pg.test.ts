import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { answerAsk } from '../src/decisions/answer.js';
import { approveSubItem } from '../src/decisions/approveSubItem.js';
import { FIX_ASK_HOLD, FIX_ASK_START, checkKeyOf, gateFixRound } from '../src/decisions/fixRoundGate.js';
import { readStartDecision } from '../src/work-items/startDecision.js';
import { withTenant } from '../src/tenancy/withTenant.js';

/**
 * D#483 S5-b2a part 3: the CHECK fix-round gate against a real Postgres, on the receipt pool. A check fix round has no `fix_round_started` event, so its key names the
 * failed run it would resume (`check-<12 hex>`): one failed run, one key, one approval.
 */
const LOGIN = 'fx_check_fix_gate_core_test';

describe('gateFixRound for a check fix round (D#483 S5-b2a part 3)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let receiptPool: Pool;
  let appPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${LOGIN}') THEN CREATE ROLE ${LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$`);
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

  interface Fixture { t: SeedRefs; workItemId: string; failedRun: string; specId: string; approver: string; approvalId: string | null }
  async function addUser(t: SeedRefs, role: 'owner' | 'admin' | 'member'): Promise<string> {
    const id = randomUUID();
    await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [id, `${id}@example.test`]);
    await admin.query('INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)', [t.accountId, id, role]);
    return id;
  }
  /** An executor run that ended with `status`; `reason` is the failure reason its status event carries. Created a tick after the previous one, so "newest" is unambiguous. */
  let tick = 0;
  async function failedRun(t: SeedRefs, workItemId: string, reason: string | null = 'check_failed', status = 'failed'): Promise<string> {
    const id = (await admin.query<{ id: string }>(
      `INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, created_at) VALUES ($1, $2, 'executor', 'local', $3, now() + ($4 || ' seconds')::interval) RETURNING id`, [t.accountId, workItemId, status, String(++tick)])).rows[0]!.id;
    await admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 90, 'run.status_changed', $3::jsonb)`,
      [t.accountId, id, JSON.stringify({ from: 'running', to: status, ...(reason ? { failureReason: reason } : {}) })]);
    return id;
  }
  async function fixture(o: { approved?: boolean; dial?: 'ask' | 'announce' | 'act' } = {}): Promise<Fixture> {
    const t = await seedAccount(admin, randomUUID());
    const workItemId = (await admin.query<{ id: string }>(`INSERT INTO work_items (account_id, repo_id, kind, provenance, title) VALUES ($1, $2, 'issue', 'internal', 'Build it') RETURNING id`, [t.accountId, t.repoId])).rows[0]!.id;
    const body = `Spec ${randomUUID()}`;
    const specId = (await admin.query<{ id: string }>(
      `INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, $3, $4, 'agent') RETURNING id`,
      [t.accountId, workItemId, body, createHash('sha256').update(body).digest('hex')])).rows[0]!.id;
    const approver = await addUser(t, 'admin');
    let approvalId: string | null = null;
    if (o.approved !== false) approvalId = (await withTenant(appPool, t.accountId, approver, (c) => c.query<{ o_approval_id: string }>(`SELECT * FROM work_item_approval_record($1, 'work_item_approve')`, [workItemId]))).rows[0]!.o_approval_id;
    if (o.dial) await admin.query(`INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, version, changed_by) VALUES ($1, $2, 'launch_sub_item', $3, 1, $4)`, [t.accountId, t.repoId, o.dial, approver]);
    const run = await failedRun(t, workItemId);
    return { t, workItemId, failedRun: run, specId, approver, approvalId };
  }
  const gate = (f: Fixture, person: string | null = null, run: string | undefined = f.failedRun, accountId = f.t.accountId) =>
    gateFixRound({ pool: receiptPool, accountId }, { workItemId: f.workItemId, personUserId: person, ...(run === undefined ? {} : { checkFailedRunId: run }) });
  const receiptsOf = async (f: Fixture) => (await admin.query('SELECT * FROM decision_receipts WHERE work_item_id = $1 ORDER BY created_at', [f.workItemId])).rows;
  const asksOf = async (f: Fixture) => (await admin.query(`SELECT * FROM decision_asks WHERE work_item_id = $1 AND decision_type = 'launch_sub_item' ORDER BY raised_at`, [f.workItemId])).rows;
  const advances = async (f: Fixture) => (await admin.query(`SELECT * FROM run_action_requests WHERE kind = 'advance_work_item' AND target_id = $1 AND idempotency_key LIKE 'subitem:%'`, [f.workItemId])).rows;
  const sentenceOf = (f: Fixture) => withTenant(receiptPool, f.t.accountId, async (c) => (await readStartDecision(c, f.workItemId))?.sentence ?? null);
  const answer = (f: Fixture, askId: string, choice: string, userId = f.approver) => answerAsk({ pool: receiptPool, principal: { accountId: f.t.accountId, userId } }, { askId, choice });
  const approve = (f: Fixture, key: string, userId = f.approver, accountId = f.t.accountId) => approveSubItem({ pool: receiptPool, principal: { accountId, userId } }, { workItemId: f.workItemId, key });

  describe('the key', () => {
    it('is check- plus the first 12 hex of the failed run id, and two failed runs never share one', async () => {
      expect(checkKeyOf('ABCDEF01-2345-6789-abcd-ef0123456789')).toBe('check-abcdef012345');
      const f = await fixture();
      const second = await failedRun(f.t, f.workItemId);
      expect(checkKeyOf(f.failedRun)).toMatch(/^check-[0-9a-f]{12}$/);
      expect(checkKeyOf(second)).not.toBe(checkKeyOf(f.failedRun));
    });
  });

  describe('Cautious', () => {
    it('raises ONE ask keyed by the failed run, anchored on it; a replay finds it; nothing starts; the card says so', async () => {
      const f = await fixture({ dial: 'ask' });
      const first = await gate(f);
      expect(first).toMatchObject({ proceed: false, reason: 'asked', key: checkKeyOf(f.failedRun) });
      expect(await gate(f)).toMatchObject({ proceed: false, reason: 'asked', askId: (first as { askId: string }).askId });
      const asks = await asksOf(f);
      expect(asks).toHaveLength(1);
      expect(asks[0]).toMatchObject({ sub_item_key: checkKeyOf(f.failedRun), run_id: f.failedRun, state: 'open', proposed: FIX_ASK_START });
      expect(asks[0].options.map((o: { label: string }) => o.label)).toEqual(['Start the check fix round', 'Hold it for now']);
      expect(await receiptsOf(f)).toHaveLength(0);
      expect(await sentenceOf(f)).toBe('Waiting for an owner or admin to answer in Needs you: your setting asks before the check fix round starts.');
      const racing = await fixture({ dial: 'ask' });
      const rs = await Promise.all([gate(racing), gate(racing), gate(racing)]);
      expect(rs.every((r) => !r.proceed && r.reason === 'asked')).toBe(true);
      expect(await asksOf(racing)).toHaveLength(1);
    });

    it('Start is the approval for THAT failed run only: one person receipt, one advance, a replay starts nothing more, and the next failed check asks again', async () => {
      const f = await fixture({ dial: 'ask' });
      const asked = (await gate(f)) as { askId: string };
      await answer(f, asked.askId, FIX_ASK_START);
      expect(await receiptsOf(f)).toMatchObject([{ actor: f.approver, sub_item_key: checkKeyOf(f.failedRun), spec_version_id: f.specId, run_id: f.failedRun }]);
      expect((await asksOf(f))[0]).toMatchObject({ state: 'withdrawn' });
      expect(await advances(f)).toHaveLength(1);
      expect(await gate(f)).toMatchObject({ proceed: true, how: 'already_decided' });
      await expect(answer(f, asked.askId, FIX_ASK_START)).rejects.toMatchObject({ code: 'already_answered' });
      expect(await approve(f, checkKeyOf(f.failedRun))).toMatchObject({ replayed: true, advanceActionId: null });
      expect(await advances(f)).toHaveLength(1);
      expect(await receiptsOf(f)).toHaveLength(1);
      // The round it started failed its check too: a NEW failed run, a new key, a new question. The first approval does not cover it.
      const second = await failedRun(f.t, f.workItemId);
      expect(await gate(f, null, second)).toMatchObject({ proceed: false, reason: 'asked', key: checkKeyOf(second) });
      expect(await asksOf(f)).toHaveLength(2);
      expect(await receiptsOf(f)).toHaveLength(1);
    });

    it('the card Approve and the Needs-you answer are one decision', async () => {
      const f = await fixture({ dial: 'ask' });
      const asked = (await gate(f)) as { askId: string };
      const viaCard = await approve(f, checkKeyOf(f.failedRun));
      expect(viaCard).toMatchObject({ withdrawnAsks: 1 });
      expect(viaCard.advanceActionId).not.toBeNull();
      await expect(answer(f, asked.askId, FIX_ASK_START)).rejects.toMatchObject({ code: 'already_answered' });
      expect(await advances(f)).toHaveLength(1);
      expect(await receiptsOf(f)).toHaveLength(1);
    });

    it('a review fix approval does not decide a check round, and a wrong check key is refused', async () => {
      const f = await fixture({ dial: 'ask' });
      await admin.query(`INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status) VALUES ($1, $2, 'code-reviewer', 'local', 'succeeded')`, [f.t.accountId, f.workItemId]);
      await approve(f, 'fix-1');
      expect(await gate(f)).toMatchObject({ proceed: false, reason: 'asked', key: checkKeyOf(f.failedRun) });
      await expect(approve(f, 'check-000000000000')).rejects.toMatchObject({ code: 'wrong_round' });
      expect((await receiptsOf(f)).map((r) => r.sub_item_key)).toEqual(['fix-1']);
    });

    it('a hold files nothing; an UNATTENDED re-entry asks again; a PERSON-filed one is the answer and withdraws the live ask', async () => {
      const f = await fixture({ dial: 'ask' });
      const asked = (await gate(f)) as { askId: string };
      await answer(f, asked.askId, FIX_ASK_HOLD);
      expect(await advances(f)).toHaveLength(0);
      expect(await sentenceOf(f)).toBe('The check fix round is held. It starts when an owner or admin starts it.');
      const unattended = await gate(f);
      expect(unattended).toMatchObject({ proceed: false, reason: 'asked' });
      expect((unattended as { askId: string }).askId).not.toBe(asked.askId);
      expect((await receiptsOf(f)).filter((x) => x.sub_item_key !== null)).toHaveLength(0);
      expect(await gate(f, f.approver)).toMatchObject({ proceed: true, how: 'person_answer', key: checkKeyOf(f.failedRun) });
      expect((await asksOf(f)).map((a) => a.state)).toEqual(['answered', 'withdrawn']);
      expect(await gate(f)).toMatchObject({ proceed: true, how: 'already_decided' });
      expect(await advances(f)).toHaveLength(0);
    });

    it('a person-filed advance with NO hold is not a bypass, and a plain member\'s advance after a hold starts nothing', async () => {
      const f = await fixture({ dial: 'ask' });
      expect(await gate(f, f.approver)).toMatchObject({ proceed: false, reason: 'asked' });
      expect(await receiptsOf(f)).toHaveLength(0);
      const asked = (await asksOf(f))[0];
      await answer(f, asked.id, FIX_ASK_HOLD);
      const member = await addUser(f.t, 'member');
      expect(await gate(f, member)).toMatchObject({ proceed: false, reason: 'blocked', blockedBy: 'fix_launch_forbidden' });
      expect((await receiptsOf(f)).filter((r) => r.sub_item_key !== null)).toHaveLength(0);
    });
  });

  describe('Balanced and Autonomous', () => {
    it('write ONE keyed policy receipt on the failed run, in a tenant-only transaction, and a replay writes nothing', async () => {
      const bal = await fixture();
      expect(await gate(bal)).toEqual({ proceed: true, how: 'policy_receipt', key: checkKeyOf(bal.failedRun), announce: true });
      expect(await receiptsOf(bal)).toMatchObject([{ actor: 'policy', chosen: 'announce', sub_item_key: checkKeyOf(bal.failedRun), approval_id: bal.approvalId, run_id: bal.failedRun }]);
      expect(await gate(bal)).toMatchObject({ how: 'already_decided', announce: false });
      expect(await gate(bal, bal.approver)).toMatchObject({ how: 'already_decided' });
      expect(await receiptsOf(bal)).toHaveLength(1);
      expect(await asksOf(bal)).toHaveLength(0);
      expect(await sentenceOf(bal)).toBe('The check fix round started automatically under your Balanced setting. No one had to answer.');
      const act = await fixture({ dial: 'act' });
      expect(await gate(act, act.approver)).toMatchObject({ how: 'policy_receipt', announce: false });
      expect(await receiptsOf(act)).toMatchObject([{ actor: 'policy', chosen: 'launch' }]);
      // The next failed check is its own round.
      const second = await failedRun(bal.t, bal.workItemId);
      expect(await gate(bal, null, second)).toMatchObject({ how: 'policy_receipt', key: checkKeyOf(second) });
      expect(await receiptsOf(bal)).toHaveLength(2);
    });

    it('the definer refuses a policy receipt for a check key under a dial that asks, or from a session with a person', async () => {
      const ask = await fixture({ dial: 'ask' });
      const write = (x: Fixture, userId?: string) => {
        const q = (c: PoolClient) => c.query(`SELECT * FROM sub_item_policy_receipt_write($1, $2, $3, $4, $5, 'launch', 0, 1)`, [x.workItemId, checkKeyOf(x.failedRun), x.specId, x.failedRun, x.approvalId]);
        return userId ? withTenant(receiptPool, x.t.accountId, userId, undefined, q) : withTenant(receiptPool, x.t.accountId, q);
      };
      await expect(write(ask)).rejects.toMatchObject({ code: '42501' });
      const bal = await fixture();
      await expect(write(bal, bal.approver)).rejects.toMatchObject({ code: '42501' });
      expect(await receiptsOf(ask)).toHaveLength(0);
      expect(await receiptsOf(bal)).toHaveLength(0);
    });
  });

  describe('fail closed', () => {
    it('a run that is not this item\'s failed check run is blocked with no ask and no receipt', async () => {
      for (const dial of ['ask', 'act'] as const) {
        const f = await fixture({ dial });
        const other = await fixture({ dial });
        const sibling = (await admin.query<{ id: string }>(`INSERT INTO work_items (account_id, repo_id, kind, provenance, title) VALUES ($1, $2, 'issue', 'internal', 'Sibling') RETURNING id`, [f.t.accountId, f.t.repoId])).rows[0]!.id;
        const cases: string[] = [
          other.failedRun, // another tenant's run
          await failedRun(f.t, sibling), // a failed check run of ANOTHER item of the same account
          await failedRun(f.t, f.workItemId, 'timeout'), // failed for another reason
          await failedRun(f.t, f.workItemId, null, 'succeeded'), // not failed
          await failedRun(f.t, f.workItemId, 'check_failed', 'running'), // not ended
          randomUUID(), 'not-a-uuid', '',
        ];
        for (const run of cases) expect(await gate(f, null, run)).toMatchObject({ proceed: false, reason: 'blocked', blockedBy: 'fix_launch_unreadable' });
        // A reviewer's run with a check_failed event is not an executor run.
        const rev = (await admin.query<{ id: string }>(`INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status) VALUES ($1, $2, 'code-reviewer', 'local', 'failed') RETURNING id`, [f.t.accountId, f.workItemId])).rows[0]!.id;
        await admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 90, 'run.status_changed', '{"to":"failed","failureReason":"check_failed"}')`, [f.t.accountId, rev]);
        expect(await gate(f, null, rev)).toMatchObject({ proceed: false, blockedBy: 'fix_launch_unreadable' });
        expect(await receiptsOf(f)).toHaveLength(0);
        expect(await asksOf(f)).toHaveLength(0);
      }
    });

    it('a STALE failed run (a newer executor run exists) is not current: blocked, no ask under Cautious, no receipt under Autonomous, and an existing receipt does not make it decided', async () => {
      const ask = await fixture({ dial: 'ask' });
      await failedRun(ask.t, ask.workItemId);
      expect(await gate(ask)).toMatchObject({ proceed: false, reason: 'blocked', blockedBy: 'fix_launch_unreadable' });
      expect(await asksOf(ask)).toHaveLength(0);
      const act = await fixture({ dial: 'act' });
      await failedRun(act.t, act.workItemId);
      expect(await gate(act, act.approver)).toMatchObject({ proceed: false, blockedBy: 'fix_launch_unreadable' });
      expect(await receiptsOf(act)).toHaveLength(0);
      // A receipt written while the run was current does not let the stale id through, and neither does a hold's person answer.
      const had = await fixture({ dial: 'act' });
      expect(await gate(had)).toMatchObject({ how: 'policy_receipt' });
      await failedRun(had.t, had.workItemId);
      expect(await gate(had)).toMatchObject({ proceed: false, blockedBy: 'fix_launch_unreadable' });
      const held = await fixture({ dial: 'ask' });
      const asked = (await gate(held)) as { askId: string };
      await answer(held, asked.askId, FIX_ASK_HOLD);
      await failedRun(held.t, held.workItemId);
      expect(await gate(held, held.approver)).toMatchObject({ proceed: false, blockedBy: 'fix_launch_unreadable' });
      expect((await receiptsOf(held)).filter((r) => r.sub_item_key !== null)).toHaveLength(0);
    });

    it('a receipt decides only the run it is anchored on: a second failed run whose key prefix collides is not covered', async () => {
      const f = await fixture({ dial: 'ask' });
      await approve(f, checkKeyOf(f.failedRun));
      expect(await gate(f)).toMatchObject({ proceed: true, how: 'already_decided' });
      const twin = f.failedRun.slice(0, -1) + (f.failedRun.endsWith('a') ? 'b' : 'a');
      expect(checkKeyOf(twin)).toBe(checkKeyOf(f.failedRun));
      await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, created_at) VALUES ($1, $2, $3, 'executor', 'local', 'failed', now() + interval '1 hour')`, [twin, f.t.accountId, f.workItemId]);
      await admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 90, 'run.status_changed', '{"to":"failed","failureReason":"check_failed"}')`, [f.t.accountId, twin]);
      // The receipt is anchored on the first run: it does not cover the twin, which is asked about on its own.
      expect(await gate(f, null, twin)).toMatchObject({ proceed: false, reason: 'asked' });
    });

    it('an item with no approval row is not gated, and an item that is not internal never starts', async () => {
      const f = await fixture({ approved: false, dial: 'ask' });
      expect(await gate(f)).toMatchObject({ proceed: true, how: 'not_gated' });
      expect(await receiptsOf(f)).toHaveLength(0);
      const ext = await fixture({ dial: 'act' });
      await admin.query(`UPDATE work_items SET provenance = 'external' WHERE id = $1`, [ext.workItemId]);
      expect(await gate(ext)).toMatchObject({ proceed: false, blockedBy: 'untrusted_work_creation' });
      expect(await receiptsOf(ext)).toHaveLength(0);
    });

    it('a Spec the approval does not name stops the round (approve again), with no ask', async () => {
      const f = await fixture({ dial: 'ask' });
      await admin.query(`INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 2, 'v2', $3, 'agent')`, [f.t.accountId, f.workItemId, createHash('sha256').update('v2').digest('hex')]);
      expect(await gate(f)).toMatchObject({ proceed: false, blockedBy: 'respec_needs_approval' });
      expect(await asksOf(f)).toHaveLength(0);
      await expect(approve(f, checkKeyOf(f.failedRun))).rejects.toMatchObject({ code: 'respec_needs_approval' });
    });
  });

  describe('approving a check key', () => {
    it('only while the key names the item\'s NEWEST executor run and that run failed its check', async () => {
      const f = await fixture({ dial: 'ask' });
      const stale = f.failedRun;
      const second = await failedRun(f.t, f.workItemId);
      await expect(approve(f, checkKeyOf(stale))).rejects.toMatchObject({ code: 'wrong_round' });
      expect(await receiptsOf(f)).toHaveLength(0);
      const ok = await failedRun(f.t, f.workItemId, null, 'succeeded');
      await expect(approve(f, checkKeyOf(second))).rejects.toMatchObject({ code: 'wrong_round' });
      // The key of the newest run itself, which did not fail its check, is refused too.
      await expect(approve(f, checkKeyOf(ok))).rejects.toMatchObject({ code: 'wrong_round' });
      const other = await failedRun(f.t, f.workItemId, 'timeout');
      await expect(approve(f, checkKeyOf(other))).rejects.toMatchObject({ code: 'wrong_round' });
      await expect(approve(f, 'check-XYZ')).rejects.toMatchObject({ code: 'invalid_key' });
      await expect(approve(f, 'check-0123456789abcde')).rejects.toMatchObject({ code: 'invalid_key' });
      expect(await receiptsOf(f)).toHaveLength(0);
    });

    it('is per tenant and per role: another account, a plain member and a token cannot approve', async () => {
      const f = await fixture({ dial: 'ask' });
      const other = await fixture({ dial: 'ask' });
      await expect(approve(f, checkKeyOf(f.failedRun), other.approver, other.t.accountId)).rejects.toMatchObject({ code: 'not_found' });
      await expect(approve(f, checkKeyOf(f.failedRun), await addUser(f.t, 'member'))).rejects.toMatchObject({ code: 'forbidden' });
      await expect(approveSubItem({ pool: receiptPool, principal: { accountId: f.t.accountId, userId: f.approver, tokenId: randomUUID() } }, { workItemId: f.workItemId, key: checkKeyOf(f.failedRun) })).rejects.toMatchObject({ code: 'session_required' });
      expect(await receiptsOf(f)).toHaveLength(0);
      expect(await receiptsOf(other)).toHaveLength(0);
    });
  });
});
