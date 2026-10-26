import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { answerAsk } from '../src/decisions/index.js';
import { checkStartPair, decideStart, settleStartClick } from '../src/decisions/startDecide.js';
import { raiseStartAsk, recordStartReceipt } from '../src/decisions/startGate.js';

/**
 * D#7 start gate, part (b) (migration 0916): `decideStart` and the two #508 fixes (a withdrawn ask is re-raisable; a person's click answers an asked pair and
 * decides a declined pair again), against a real Postgres with the real roles.
 */
const INVOKER_LOGIN = 'fx_start_decide_test';

describe('start decision (migration 0916) [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let receiptPool: Pool;
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
  async function item(t: SeedRefs, provenance = 'internal'): Promise<string> {
    return (await admin.query<{ id: string }>(`INSERT INTO work_items (account_id, repo_id, kind, provenance, title) VALUES ($1, $2, 'issue', $3, 'Fix it') RETURNING id`, [t.accountId, t.repoId, provenance])).rows[0]!.id;
  }
  /** A repository of its own, so a dial row in one test never leaks into another. */
  async function repoWithDial(t: SeedRefs, disposition: 'ask' | 'announce' | 'act' | null, type = 'start_work_small'): Promise<string> {
    const repoId = (await admin.query<{ id: string }>(`INSERT INTO repos (account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, 'team') RETURNING id`, [t.accountId, t.installationId, 100 + Math.floor(Math.random() * 1e9)])).rows[0]!.id;
    if (disposition !== null) {
      await admin.query(`INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, version, changed_by) VALUES ($1, $2, $3, $4, 1, $5)`, [t.accountId, repoId, type, disposition, t.userId]);
    }
    return repoId;
  }
  async function itemIn(t: SeedRefs, repoId: string): Promise<string> {
    return (await admin.query<{ id: string }>(`INSERT INTO work_items (account_id, repo_id, kind, provenance, title) VALUES ($1, $2, 'issue', 'internal', 'Fix it') RETURNING id`, [t.accountId, repoId])).rows[0]!.id;
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
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    aAdmin = await addUser(a.accountId, 'admin');
    aMember = await addUser(a.accountId, 'member');
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), receiptPool.end()]);
  });

  const ctx = (t: SeedRefs) => ({ pool: receiptPool, accountId: t.accountId });
  const as = (t: SeedRefs, userId: string = t.userId) => ({ pool: receiptPool, principal: { accountId: t.accountId, userId } });
  const one = async (sql: string, args: unknown[]) => (await admin.query(sql, args)).rows[0];
  const gateOf = (wi: string, type = 'start_work_small') => one(`SELECT * FROM start_gate WHERE work_item_id = $1 AND decision_type = $2`, [wi, type]);
  const receipts = async (wi: string) => (await admin.query(`SELECT * FROM decision_receipts WHERE work_item_id = $1 ORDER BY created_at, id`, [wi])).rows;
  const asks = async (wi: string) => (await admin.query(`SELECT * FROM decision_asks WHERE work_item_id = $1 ORDER BY raised_at, id`, [wi])).rows;
  const advances = async (wi: string) => (await admin.query(`SELECT * FROM run_action_requests WHERE kind = 'advance_work_item' AND target_id = $1`, [wi])).rows;
  const unattended = (t: SeedRefs, workItemId: string, category: string | null = 'small', cameInAs: string | null = null) =>
    decideStart(ctx(t), { workItemId, origin: 'unattended', category, cameInAs });
  const click = (t: SeedRefs, workItemId: string, category: string | null = 'small', cameInAs: string | null = null, userId: string = aAdmin) =>
    decideStart(ctx(t), { workItemId, origin: 'person_click', userId, category, cameInAs });
  const withdraw = (askId: string) => admin.query(`UPDATE decision_asks SET state = 'withdrawn' WHERE id = $1`, [askId]);

  describe('the dial (origin: unattended)', () => {
    it('with no dial row the repository is Balanced: a policy receipt, the item continues, and a replay changes nothing', async () => {
      const wi = await itemIn(a, await repoWithDial(a, null));
      const first = await unattended(a, wi);
      expect(first).toMatchObject({ proceed: true, how: 'policy_receipt', decisionType: 'start_work_small', preset: 'balanced', announce: true });
      expect(await receipts(wi)).toMatchObject([{ actor: 'policy', chosen: 'start', run_id: null, decision_type: 'start_work_small', class: 'human_over_the_loop', dial_version: 0 }]);
      expect(await gateOf(wi)).toMatchObject({ outcome: 'started', preset: 'balanced', decided_by: 'policy' });
      expect(await asks(wi)).toEqual([]);
      expect(await unattended(a, wi)).toMatchObject({ proceed: true, how: 'already_started' });
      expect(await receipts(wi)).toHaveLength(1);
    });

    it('an Autonomous dial row starts it without saying so; each small kind has its own dial and decision type', async () => {
      const repo = await repoWithDial(a, 'act');
      const wi = await itemIn(a, repo);
      expect(await unattended(a, wi)).toMatchObject({ proceed: true, how: 'policy_receipt', preset: 'autonomous', announce: false, receiptId: expect.any(String) });
      // The bug dial has no row in this repository: Balanced.
      const bug = await itemIn(a, repo);
      expect(await unattended(a, bug, 'bug')).toMatchObject({ proceed: true, decisionType: 'start_work_bug', preset: 'balanced' });
      expect(await receipts(wi)).toMatchObject([{ dial_version: 1 }]);
    });

    it('a Cautious dial row raises ONE ask and parks the item; answering it starts it once and the item resumes without asking again', async () => {
      const wi = await itemIn(a, await repoWithDial(a, 'ask'));
      const first = await unattended(a, wi);
      expect(first).toMatchObject({ proceed: false, reason: 'asked', decisionType: 'start_work_small', askId: expect.any(String) });
      expect(await unattended(a, wi)).toMatchObject({ proceed: false, reason: 'asked', askId: (first as { askId: string }).askId });
      expect(await asks(wi)).toHaveLength(1);
      expect(await receipts(wi)).toEqual([]);

      const sent: unknown[] = [];
      const res = await answerAsk({ ...as(a, aAdmin), signal: { signal: async (m: unknown) => void sent.push(m) } }, { askId: (first as { askId: string }).askId, choice: 'start' });
      const reqs = await advances(wi);
      expect(reqs).toHaveLength(1);
      expect(reqs[0]).toMatchObject({ idempotency_key: `startask:${(first as { askId: string }).askId}`, requested_by: `session:${aAdmin}` });
      expect(sent).toHaveLength(1);
      // The resumed advance reaches the gate again: the pair is started, nothing is asked or recorded a second time.
      expect(await unattended(a, wi)).toMatchObject({ proceed: true, how: 'already_started', receiptId: res.receiptId });
      expect(await click(a, wi)).toMatchObject({ proceed: true, how: 'already_started' });
      expect(await asks(wi)).toHaveLength(1);
      expect(await receipts(wi)).toHaveLength(1);
      expect(await advances(wi)).toHaveLength(1);
    });

    it('the dial never overrides a hold, and never asks a started pair again', async () => {
      const repo = await repoWithDial(a, 'ask');
      const wi = await itemIn(a, repo);
      const asked = await unattended(a, wi);
      await answerAsk(as(a, aAdmin), { askId: (asked as { askId: string }).askId, choice: 'hold' });
      expect(await unattended(a, wi)).toMatchObject({ proceed: false, reason: 'held' });
      await admin.query(`INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, version, changed_by) VALUES ($1, $2, 'start_work_small', 'act', 2, $3)`, [a.accountId, repo, a.userId]);
      expect(await unattended(a, wi)).toMatchObject({ proceed: false, reason: 'held' });
      expect(await receipts(wi)).toMatchObject([{ chosen: 'hold' }]);
      expect(await asks(wi)).toHaveLength(1);
    });

    it('a feature or critical item, and a reclassified one, is always asked, even when the dial is Autonomous', async () => {
      const repo = await repoWithDial(a, 'act');
      const feature = await itemIn(a, repo);
      expect(await unattended(a, feature, 'feature')).toMatchObject({ proceed: false, reason: 'asked', decisionType: 'start_parent_item' });
      expect(await receipts(feature)).toEqual([]);
      const reclass = await itemIn(a, repo);
      expect(await unattended(a, reclass, 'critical', 'bug')).toMatchObject({ proceed: false, reason: 'asked', decisionType: 'start_after_reclassify' });
    });

    it('a category that is not started (a question, a project) is not gated and records nothing', async () => {
      const wi = await item(a);
      expect(await unattended(a, wi, 'question')).toMatchObject({ proceed: true, how: 'not_gated', decisionType: null });
      expect(await unattended(a, wi, null)).toMatchObject({ proceed: true, how: 'not_gated' });
      expect([await gateOf(wi), await receipts(wi)]).toEqual([undefined, []]);
    });
  });

  describe('the click (origin: person_click)', () => {
    it('a person start records a PERSON receipt and never raises an ask, even under a Cautious dial', async () => {
      const wi = await itemIn(a, await repoWithDial(a, 'ask'));
      const r = await click(a, wi);
      expect(r).toMatchObject({ proceed: true, how: 'person_receipt', decisionType: 'start_work_small' });
      expect(await receipts(wi)).toMatchObject([{ actor: aAdmin, chosen: 'start', run_id: null, rejected_alternative: 'wait_for_approval' }]);
      expect(await gateOf(wi)).toMatchObject({ outcome: 'started', decided_by: aAdmin, preset: 'cautious' });
      expect(await asks(wi)).toEqual([]);
      expect(await click(a, wi)).toMatchObject({ proceed: true, how: 'already_started' });
      expect(await receipts(wi)).toHaveLength(1);
    });

    it('the build entry (no category given) reads the item\'s kind: a feature records a person start_parent_item receipt, no ask', async () => {
      const wi = await item(a);
      const discussion = randomUUID();
      await admin.query(`INSERT INTO discussions (id, account_id, number, kind, title, root_work_item_id, provenance, created_by_kind) VALUES ($1, $2, $3, 'feature', 't', $4, 'internal', 'user')`, [discussion, a.accountId, 7000 + Math.floor(Math.random() * 1000), wi]);
      await admin.query(`UPDATE work_items SET discussion_id = $2 WHERE id = $1`, [wi, discussion]);
      const r = await click(a, wi, null);
      expect(r).toMatchObject({ proceed: true, how: 'person_receipt', decisionType: 'start_parent_item' });
      expect(await receipts(wi)).toMatchObject([{ actor: aAdmin, class: 'human_in_the_loop', decision_type: 'start_parent_item' }]);
      expect(await asks(wi)).toEqual([]);
    });

    it('an item that came in small and was found larger is asked even after the click, and the answer lets the panel run', async () => {
      const wi = await itemIn(a, await repoWithDial(a, 'act'));
      const r = await click(a, wi, 'feature', 'small');
      expect(r).toMatchObject({ proceed: false, reason: 'asked', decisionType: 'start_after_reclassify', askId: expect.any(String) });
      expect(await receipts(wi)).toEqual([]);
      expect(await click(a, wi, 'feature', 'small')).toMatchObject({ proceed: false, reason: 'asked', askId: (r as { askId: string }).askId });
      expect(await asks(wi)).toHaveLength(1);
      await answerAsk({ ...as(a, aAdmin), signal: { signal: async () => undefined } }, { askId: (r as { askId: string }).askId, choice: 'start' });
      expect(await click(a, wi, 'feature', 'small')).toMatchObject({ proceed: true, how: 'already_started', decisionType: 'start_after_reclassify' });
      expect(await receipts(wi)).toHaveLength(1);
    });

    it('a click on a pair whose ask is open ANSWERS that ask: a person receipt, the ask answered, no second ask, no advance request', async () => {
      const wi = await itemIn(a, await repoWithDial(a, 'ask'));
      const asked = (await unattended(a, wi)) as { askId: string };
      const r = await click(a, wi);
      expect(r).toMatchObject({ proceed: true, how: 'answered_ask' });
      expect(await one(`SELECT state, answered_option, answered_by, receipt_id FROM decision_asks WHERE id = $1`, [asked.askId])).toMatchObject({ state: 'answered', answered_option: 'start', answered_by: aAdmin, receipt_id: (r as { receiptId: string }).receiptId });
      expect(await gateOf(wi)).toMatchObject({ outcome: 'started', decided_by: aAdmin, receipt_id: (r as { receiptId: string }).receiptId, ask_id: asked.askId });
      expect(await receipts(wi)).toMatchObject([{ actor: aAdmin, chosen: 'start' }]);
      expect(await asks(wi)).toHaveLength(1);
      expect(await advances(wi)).toEqual([]);
      expect(await click(a, wi)).toMatchObject({ proceed: true, how: 'already_started' });
    });

    it('a click on a declined pair decides again with a new person receipt; the hold receipt stays as history', async () => {
      const wi = await itemIn(a, await repoWithDial(a, 'ask'));
      const asked = (await unattended(a, wi)) as { askId: string };
      const hold = await answerAsk(as(a, aAdmin), { askId: asked.askId, choice: 'hold' });
      expect(await gateOf(wi)).toMatchObject({ outcome: 'declined', receipt_id: hold.receiptId });
      const r = await click(a, wi);
      expect(r).toMatchObject({ proceed: true, how: 'person_receipt' });
      expect((r as { receiptId: string }).receiptId).not.toBe(hold.receiptId);
      expect(await gateOf(wi)).toMatchObject({ outcome: 'started', receipt_id: (r as { receiptId: string }).receiptId, decided_by: aAdmin });
      expect((await receipts(wi)).map((x) => x.chosen)).toEqual(['hold', 'start']);
      expect(await asks(wi)).toHaveLength(1);
      expect((await admin.query(`SELECT 1 FROM audit_log WHERE account_id = $1 AND action = 'start_gate.reopened' AND payload ->> 'work_item_id' = $2`, [a.accountId, wi])).rows).toHaveLength(1);
    });

    it('the spec entry settles a reclassify pair: it answers an open ask, decides a held one again, and does nothing for an item with no pair', async () => {
      const repo = await repoWithDial(a, 'act');
      const open = await itemIn(a, repo);
      await click(a, open, 'feature', 'bug');
      expect(await settleStartClick(ctx(a), { workItemId: open, userId: aAdmin })).toMatchObject({ proceed: true, how: 'answered_ask' });
      expect(await gateOf(open, 'start_after_reclassify')).toMatchObject({ outcome: 'started', decided_by: aAdmin });

      const held = await itemIn(a, repo);
      const r = (await click(a, held, 'critical', 'doc')) as { askId: string };
      await answerAsk(as(a, aAdmin), { askId: r.askId, choice: 'deny' });
      expect(await settleStartClick(ctx(a), { workItemId: held, userId: aAdmin })).toMatchObject({ proceed: true, how: 'person_receipt' });
      expect((await receipts(held)).map((x) => x.chosen)).toEqual(['deny', 'start']);

      const none = await itemIn(a, repo);
      expect(await settleStartClick(ctx(a), { workItemId: none, userId: aAdmin })).toMatchObject({ proceed: true, how: 'not_gated' });
      expect(await gateOf(none, 'start_after_reclassify')).toBeUndefined();
    });

    it('a plain member\'s click is refused and records nothing; so is a click on a work item of another account', async () => {
      const wi = await itemIn(a, await repoWithDial(a, null));
      await expect(click(a, wi, 'small', null, aMember)).rejects.toMatchObject({ code: '42501' });
      expect([await gateOf(wi), await receipts(wi)]).toEqual([undefined, []]);
      await expect(decideStart(ctx(b), { workItemId: wi, origin: 'person_click', userId: b.userId, category: 'small' })).rejects.toThrow('no such work item');
    });
  });

  describe('a restart nobody clicked (the parked-stage sweep, the slot wake)', () => {
    const personReceipts = async (wi: string) => (await receipts(wi)).filter((x) => x.actor !== 'policy');

    it('a restart parked at classify (came in small, triaged as a feature) is asked, never started: no panel until a person answers', async () => {
      const wi = await itemIn(a, await repoWithDial(a, 'act'));
      const r = await unattended(a, wi, 'feature', 'small');
      expect(r).toMatchObject({ proceed: false, reason: 'asked', decisionType: 'start_after_reclassify' });
      expect(await gateOf(wi, 'start_after_reclassify')).toMatchObject({ outcome: 'asked' });
      expect(await receipts(wi)).toEqual([]);
      // Again (a second restart): the same open ask, no second one.
      expect(await unattended(a, wi, 'feature', 'small')).toMatchObject({ proceed: false, reason: 'asked', askId: (r as { askId: string }).askId });
      expect(await asks(wi)).toHaveLength(1);
    });

    it('a restart of a declined pair stays held, whatever the dial says, and of a declined reclassify pair too', async () => {
      const wi = await itemIn(a, await repoWithDial(a, 'act'));
      const asked = (await unattended(a, wi, 'feature', 'small')) as { askId: string };
      await answerAsk(as(a, aAdmin), { askId: asked.askId, choice: 'deny' });
      expect(await unattended(a, wi, 'feature', 'small')).toMatchObject({ proceed: false, reason: 'held' });
      expect(await checkStartPair(ctx(a), { workItemId: wi })).toMatchObject({ proceed: false, reason: 'held' });
      expect((await receipts(wi)).map((x) => x.chosen)).toEqual(['deny']);
    });

    it('a restart of a started pair goes on without a new receipt, for the dial path and for the spec entry', async () => {
      const wi = await itemIn(a, await repoWithDial(a, 'ask'));
      const asked = (await unattended(a, wi, 'feature', 'small')) as { askId: string };
      await answerAsk({ ...as(a, aAdmin), signal: { signal: async () => undefined } }, { askId: asked.askId, choice: 'start' });
      const before = await receipts(wi);
      expect(before).toHaveLength(1);
      expect(await unattended(a, wi, 'feature', 'small')).toMatchObject({ proceed: true, how: 'already_started' });
      expect(await checkStartPair(ctx(a), { workItemId: wi })).toMatchObject({ proceed: true, how: 'already_started' });
      expect(await receipts(wi)).toEqual(before);
    });

    it('the slot wake\'s build restart (the item\'s kind is known) records at most a policy receipt, never a person\'s', async () => {
      const small = await itemIn(a, await repoWithDial(a, null));
      expect(await unattended(a, small, 'small')).toMatchObject({ proceed: true, how: 'policy_receipt' });
      expect(await personReceipts(small)).toEqual([]);
      // A feature at the build entry is a class 3 start: asked, no receipt at all.
      const feature = await itemIn(a, await repoWithDial(a, 'act'));
      expect(await unattended(a, feature, 'feature')).toMatchObject({ proceed: false, reason: 'asked', decisionType: 'start_parent_item' });
      expect(await receipts(feature)).toEqual([]);
    });

    it('the spec entry on a restart: no pair goes on and writes nothing; an open ask stays open; a withdrawn class 3 pair is asked again, never started', async () => {
      const none = await itemIn(a, await repoWithDial(a, null));
      expect(await checkStartPair(ctx(a), { workItemId: none })).toMatchObject({ proceed: true, how: 'not_gated' });
      expect(await gateOf(none, 'start_after_reclassify')).toBeUndefined();

      const open = await itemIn(a, await repoWithDial(a, 'act'));
      const first = (await unattended(a, open, 'feature', 'small')) as { askId: string };
      expect(await checkStartPair(ctx(a), { workItemId: open })).toMatchObject({ proceed: false, reason: 'asked', askId: first.askId });
      expect(await asks(open)).toHaveLength(1);

      await withdraw(first.askId);
      const again = await checkStartPair(ctx(a), { workItemId: open });
      expect(again).toMatchObject({ proceed: false, reason: 'asked', askId: expect.any(String) });
      expect((again as { askId: string }).askId).not.toBe(first.askId);
      expect(await gateOf(open, 'start_after_reclassify')).toMatchObject({ outcome: 'asked' });
      expect(await receipts(open)).toEqual([]);
    });
  });

  describe('the fixed invariants win', () => {
    it('an item that is not internal is never started, by the dial or by a click, and nothing is recorded', async () => {
      const wi = await item(a, 'external');
      expect(await unattended(a, wi)).toMatchObject({ proceed: false, reason: 'blocked', blockedBy: 'untrusted_work_creation' });
      expect(await click(a, wi)).toMatchObject({ proceed: false, reason: 'blocked', blockedBy: 'untrusted_work_creation' });
      expect([await gateOf(wi), await receipts(wi), await asks(wi)]).toEqual([undefined, [], []]);
    });

    it('an item the repository\'s own loop owns is never started', async () => {
      const wi = await item(a);
      await admin.query(
        `INSERT INTO proposals (account_id, repo_id, dedupe_key, sources, title, provenance, owner_process, work_item_id)
         VALUES ($1, $2, $3, ARRAY['github_issue'], 'p', 'internal', 'internal_loop', $4)`,
        [a.accountId, a.repoId, `gh:issue:${Math.floor(Math.random() * 1e8) + 1}`, wi],
      );
      expect(await click(a, wi)).toMatchObject({ proceed: false, reason: 'blocked', blockedBy: 'owned_by_internal_loop' });
      expect(await gateOf(wi)).toBeUndefined();
    });
  });

  describe('a withdrawn ask is an undo path, not a dead end (migration 0916)', () => {
    it('the dial asks again with a NEW ask; the old one stays withdrawn; the gate row follows the new ask', async () => {
      const wi = await itemIn(a, await repoWithDial(a, 'ask'));
      const first = (await unattended(a, wi)) as { askId: string };
      await withdraw(first.askId);
      const second = await unattended(a, wi);
      expect(second).toMatchObject({ proceed: false, reason: 'asked', askId: expect.any(String) });
      expect((second as { askId: string }).askId).not.toBe(first.askId);
      expect((await asks(wi)).map((x) => x.state)).toEqual(['withdrawn', 'open']);
      expect(await gateOf(wi)).toMatchObject({ outcome: 'asked', ask_id: (second as { askId: string }).askId, receipt_id: null, decided_at: null });
      expect(await unattended(a, wi)).toMatchObject({ reason: 'asked', askId: (second as { askId: string }).askId });
      expect((await admin.query(`SELECT action FROM audit_log WHERE account_id = $1 AND payload ->> 'work_item_id' = $2 AND action LIKE 'start_gate.%' ORDER BY created_at, id`, [a.accountId, wi])).rows.map((r) => r.action)).toEqual([
        'start_gate.recorded', 'start_gate.withdrawn', 'start_gate.reopened',
      ]);
      // The new ask is answerable and starts the item once.
      await answerAsk({ ...as(a, aAdmin), signal: { signal: async () => undefined } }, { askId: (second as { askId: string }).askId, choice: 'start' });
      expect(await advances(wi)).toHaveLength(1);
    });

    it('an Autonomous dial starts a withdrawn class 2 pair with a policy receipt; a person\'s click starts it with a person receipt', async () => {
      const repo = await repoWithDial(a, 'ask');
      const policy = await itemIn(a, repo);
      const asked = (await unattended(a, policy)) as { askId: string };
      await withdraw(asked.askId);
      await admin.query(`INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, version, changed_by) VALUES ($1, $2, 'start_work_small', 'act', 2, $3)`, [a.accountId, repo, a.userId]);
      expect(await unattended(a, policy)).toMatchObject({ proceed: true, how: 'policy_receipt' });
      expect(await gateOf(policy)).toMatchObject({ outcome: 'started', decided_by: 'policy' });

      const person = await itemIn(a, await repoWithDial(a, 'ask'));
      const asked2 = (await unattended(a, person)) as { askId: string };
      await withdraw(asked2.askId);
      expect(await click(a, person)).toMatchObject({ proceed: true, how: 'person_receipt' });
      expect(await receipts(person)).toMatchObject([{ actor: aAdmin }]);
      expect(await gateOf(person)).toMatchObject({ outcome: 'started', decided_by: aAdmin });
    });

    it('a withdrawn class 3 pair is asked again, and never started by the dial', async () => {
      const wi = await itemIn(a, await repoWithDial(a, 'act'));
      const first = (await unattended(a, wi, 'feature')) as { askId: string };
      await withdraw(first.askId);
      expect(await unattended(a, wi, 'feature')).toMatchObject({ proceed: false, reason: 'asked' });
      expect(await asks(wi)).toHaveLength(2);
      expect(await receipts(wi)).toEqual([]);
    });
  });

  describe('each layer on its own (direct SQL, the real roles)', () => {
    async function inSession<T>(t: SeedRefs, userId: string | null, fn: (c: PoolClient) => Promise<T>): Promise<T> {
      const c = await receiptPool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.account_id', $1, true)`, [t.accountId]);
        if (userId !== null) await c.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);
        return await fn(c);
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    }
    const refusedWith = (p: Promise<unknown>, code: string) => expect(p).rejects.toMatchObject({ code });

    it('a plain member cannot claim, write a receipt, answer an ask, reopen or release', async () => {
      const wi = await itemIn(a, await repoWithDial(a, 'ask'));
      const asked = (await unattended(a, wi)) as { askId: string };
      const gate = (await gateOf(wi)).id as string;
      await inSession(a, aMember, async (c) => {
        await refusedWith(c.query(`SELECT * FROM start_gate_claim($1::uuid, 'start_work_small', 'balanced', 0, 'started')`, [wi]), '42501');
      });
      await inSession(a, aMember, (c) => refusedWith(c.query(`SELECT start_receipt_write($1::uuid, 'start_work_small', 'start', 'wait_for_approval', 0, 1)`, [wi]), '42501'));
      await inSession(a, aMember, (c) => refusedWith(c.query(`SELECT start_receipt_write($1::uuid, 'start_work_small', 'hold', 'start', 0, 1)`, [wi]), '42501'));
      await inSession(a, aMember, (c) => refusedWith(c.query(`SELECT start_receipt_write($1::uuid, 'start_work_small', 'deny', 'start', 0, 1)`, [wi]), '42501'));
      await inSession(a, aMember, (c) => refusedWith(c.query(`SELECT start_ask_answer($1::uuid, 'start', $1::uuid)`, [asked.askId]), '42501'));
      await inSession(a, aMember, (c) => refusedWith(c.query(`SELECT start_gate_reopen($1::uuid, 'started')`, [gate]), '42501'));
      await inSession(a, aMember, (c) => refusedWith(c.query(`SELECT start_gate_release($1::uuid)`, [gate]), '42501'));
      expect(await receipts(wi)).toEqual([]);
      expect(await gateOf(wi)).toMatchObject({ outcome: 'asked' });
    });

    it('a member cannot hold or deny an ask through the answer service either', async () => {
      const wi = await itemIn(a, await repoWithDial(a, 'ask'));
      const asked = (await unattended(a, wi)) as { askId: string };
      for (const choice of ['hold', 'deny']) {
        await expect(answerAsk(as(a, aMember), { askId: asked.askId, choice })).rejects.toMatchObject({ name: 'AskAnswerError', status: 403, code: 'forbidden' });
      }
      expect([await one(`SELECT state FROM decision_asks WHERE id = $1`, [asked.askId]), await receipts(wi)]).toEqual([{ state: 'open' }, []]);
    });

    it('the policy session cannot claim a class 3 start, write a hold or a class 3 receipt, or start a declined pair', async () => {
      const wi = await itemIn(a, await repoWithDial(a, 'ask'));
      await inSession(a, null, (c) => refusedWith(c.query(`SELECT * FROM start_gate_claim($1::uuid, 'start_parent_item', 'autonomous', 0, 'started')`, [wi]), '42501'));
      await inSession(a, null, (c) => refusedWith(c.query(`SELECT * FROM start_gate_claim($1::uuid, 'start_after_reclassify', 'autonomous', 0, 'started')`, [wi]), '42501'));
      await inSession(a, null, (c) => refusedWith(c.query(`SELECT start_receipt_write($1::uuid, 'start_parent_item', 'start', 'wait_for_approval', 0, 1)`, [wi]), '42501'));
      await inSession(a, null, (c) => refusedWith(c.query(`SELECT start_receipt_write($1::uuid, 'start_work_small', 'hold', 'start', 0, 1)`, [wi]), '42501'));
      const asked = (await unattended(a, wi)) as { askId: string };
      await answerAsk(as(a, aAdmin), { askId: asked.askId, choice: 'hold' });
      const gate = (await gateOf(wi)).id as string;
      await inSession(a, null, (c) => refusedWith(c.query(`SELECT start_gate_reopen($1::uuid, 'started')`, [gate]), '42501'));
      expect(await gateOf(wi)).toMatchObject({ outcome: 'declined' });
    });

    it('the policy session cannot reopen a withdrawn class 3 pair to started (the definer\'s own class check), though it can a withdrawn class 2 pair', async () => {
      const wi = await itemIn(a, await repoWithDial(a, 'act'));
      const asked = (await unattended(a, wi, 'feature', 'small')) as { askId: string };
      await withdraw(asked.askId);
      const gate = (await gateOf(wi, 'start_after_reclassify')).id as string;
      // Release the pair to `withdrawn` (what the next caller would do), then try the dial's start on it, in one session with no person.
      await inSession(a, null, async (c) => {
        await c.query(`SELECT start_gate_release($1::uuid)`, [gate]);
        expect((await c.query(`SELECT outcome FROM start_gate WHERE id = $1`, [gate])).rows[0]).toMatchObject({ outcome: 'withdrawn' });
        await expect(c.query(`SELECT start_gate_reopen($1::uuid, 'started')`, [gate])).rejects.toMatchObject({ code: '42501', message: expect.stringContaining("this start is a person's") });
      });
      expect(await gateOf(wi, 'start_after_reclassify')).toMatchObject({ outcome: 'asked' });
      expect(await receipts(wi)).toEqual([]);

      // Control: the same two steps on a class 2 pair do work, so the refusal above is the class check and not the setup.
      const small = await itemIn(a, await repoWithDial(a, 'ask'));
      const smallAsk = (await unattended(a, small)) as { askId: string };
      await withdraw(smallAsk.askId);
      const smallGate = (await gateOf(small)).id as string;
      await inSession(a, null, async (c) => {
        await c.query(`SELECT start_gate_release($1::uuid)`, [smallGate]);
        expect((await c.query(`SELECT start_gate_reopen($1::uuid, 'started') AS o`, [smallGate])).rows[0]).toMatchObject({ o: 'started' });
      });
    });

    it('a person cannot raise an ask or reopen one; release and reopen refuse the wrong state', async () => {
      const wi = await itemIn(a, await repoWithDial(a, 'ask'));
      const asked = (await unattended(a, wi)) as { askId: string };
      const gate = (await gateOf(wi)).id as string;
      await inSession(a, aAdmin, (c) => refusedWith(c.query(`SELECT * FROM start_gate_claim($1::uuid, 'start_work_doc', 'cautious', 0, 'asked')`, [wi]), '42501'));
      await inSession(a, aAdmin, (c) => refusedWith(c.query(`SELECT start_gate_reopen($1::uuid, 'asked')`, [gate]), '42501'));
      // An open ask is not withdrawn: release changes nothing, and reopen has nothing to open.
      await inSession(a, aAdmin, async (c) => expect((await c.query(`SELECT start_gate_release($1::uuid) AS o`, [gate])).rows[0].o).toBe('asked'));
      await inSession(a, aAdmin, (c) => refusedWith(c.query(`SELECT start_gate_reopen($1::uuid, 'started')`, [gate]), '55000'));
      await inSession(a, null, (c) => refusedWith(c.query(`SELECT start_gate_reopen($1::uuid, 'asked')`, [gate]), '55000'));
      await withdraw(asked.askId);
      await inSession(a, null, async (c) => expect((await c.query(`SELECT start_gate_release($1::uuid) AS o`, [gate])).rows[0].o).toBe('withdrawn'));
    });

    it('another account cannot release or reopen the row; a token session cannot do anything', async () => {
      const wi = await itemIn(a, await repoWithDial(a, 'ask'));
      await unattended(a, wi);
      const gate = (await gateOf(wi)).id as string;
      await inSession(b, b.userId, (c) => refusedWith(c.query(`SELECT start_gate_release($1::uuid)`, [gate]), 'P0002'));
      await inSession(b, b.userId, (c) => refusedWith(c.query(`SELECT start_gate_reopen($1::uuid, 'started')`, [gate]), 'P0002'));
      for (const sql of [`SELECT start_gate_release($1::uuid)`, `SELECT start_gate_reopen($1::uuid, 'started')`]) {
        await inSession(a, aAdmin, async (c) => {
          await c.query(`SELECT set_config('app.token_id', 'tok', true)`);
          await refusedWith(c.query(sql, [gate]), '42501');
        });
      }
    });

    it('the row\'s own trigger: a started row is final, a declined row can only be started, an open row cannot jump back', async () => {
      const wi = await itemIn(a, await repoWithDial(a, null));
      await click(a, wi);
      await expect(admin.query(`UPDATE start_gate SET outcome = 'withdrawn' WHERE work_item_id = $1`, [wi])).rejects.toMatchObject({ message: expect.stringContaining('start_gate_terminal') });
      const held = await itemIn(a, await repoWithDial(a, 'ask'));
      const asked = (await unattended(a, held)) as { askId: string };
      await answerAsk(as(a, aAdmin), { askId: asked.askId, choice: 'hold' });
      await expect(admin.query(`UPDATE start_gate SET outcome = 'asked', receipt_id = NULL, decided_at = NULL WHERE work_item_id = $1`, [held])).rejects.toMatchObject({ message: expect.stringContaining('start_gate_terminal') });
      await expect(admin.query(`UPDATE start_gate SET outcome = 'withdrawn' WHERE work_item_id = $1`, [held])).rejects.toMatchObject({ message: expect.stringContaining('start_gate_terminal') });
    });
  });

  it('recordStartReceipt and raiseStartAsk keep their part (a) behaviour for a pair with no row', async () => {
    const wi = await item(a);
    expect(await recordStartReceipt(ctx(a), { workItemId: wi, decisionType: 'start_work_doc', preset: 'balanced' })).toMatchObject({ outcome: 'started', replayed: false });
    expect(await raiseStartAsk(ctx(a), { workItemId: wi, decisionType: 'start_work_doc', preset: 'cautious' })).toMatchObject({ outcome: 'started', replayed: true });
  });
});
