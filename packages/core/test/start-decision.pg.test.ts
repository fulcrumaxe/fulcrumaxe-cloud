import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { answerAsk } from '../src/decisions/index.js';
import { raiseStartAsk, recordStartReceipt } from '../src/decisions/startGate.js';
import { describeStartDecision, readStartDecision, type StartGateFacts } from '../src/work-items/startDecision.js';
import { withTenant } from '../src/tenancy/withTenant.js';

/** D#7 start gate (c): the words a card shows for each start outcome (pure), and the read of the item's gate row against a real Postgres. */
const facts = (over: Partial<StartGateFacts> = {}): StartGateFacts => ({
  outcome: 'started', decision_type: 'start_work_small', preset: 'balanced', decided_by: 'policy', decided_at: new Date('2026-10-20T14:05:00Z'), name: null, ...over,
});
const PERSON = '5b0c1d9e-0000-4000-8000-000000000001';

describe('describeStartDecision (the sentence for each outcome)', () => {
  it('an open ask says it waits for the person and where to answer, by kind of work', () => {
    const d = describeStartDecision(facts({ outcome: 'asked', decided_by: null, decided_at: null, preset: 'cautious', decision_type: 'start_work_bug' }));
    expect(d).toEqual({ state: 'asked', by: null, name: null, at: null, sentence: 'Waiting for an owner or admin to answer in Needs you: your Cautious setting asks before a bug fix starts.' });
    expect(describeStartDecision(facts({ outcome: 'asked', decision_type: 'start_after_reclassify', decided_by: null, decided_at: null })).sentence).toMatch(/turned out larger/);
  });

  it('a start by a person names them, or says "a person" when the name is unknown, and records when', () => {
    expect(describeStartDecision(facts({ decided_by: PERSON, name: 'Ada Lovelace' }))).toMatchObject({ state: 'started', by: 'person', name: 'Ada Lovelace', at: '2026-10-20T14:05:00.000Z', sentence: 'Started by Ada Lovelace.' });
    for (const name of [null, '', '   ']) expect(describeStartDecision(facts({ decided_by: PERSON, name })).sentence).toBe('Started by a person.');
    expect(describeStartDecision(facts({ decided_by: PERSON, name: 'x'.repeat(500) })).name).toHaveLength(80);
  });

  it('a start under the dial names the setting and says no one had to answer', () => {
    const d = describeStartDecision(facts({ preset: 'autonomous' }));
    expect(d).toMatchObject({ state: 'started', by: 'dial', name: null });
    expect(d.sentence).toBe('Started automatically under your Autonomous setting. No one had to answer.');
  });

  it('a hold, a withdrawn ask and the re-decide wording read as sentences', () => {
    expect(describeStartDecision(facts({ outcome: 'declined', decided_by: PERSON, name: 'Ada Lovelace' })).sentence).toBe('Held by Ada Lovelace. It does not start until a person starts it.');
    expect(describeStartDecision(facts({ outcome: 'declined' })).sentence).toBe('Held. It does not start until a person starts it.');
    const w = describeStartDecision(facts({ outcome: 'withdrawn' }));
    expect(w).toMatchObject({ state: 'withdrawn', by: null, at: null });
    expect(w.sentence).toMatch(/withdrawn before anyone answered.*decided again/);
  });

  it('an outcome, kind or preset it does not know reads as a safe generic sentence, never a code', () => {
    const odd = describeStartDecision(facts({ outcome: 'brand_new' }));
    expect(odd).toEqual({ state: 'unknown', by: null, name: null, at: null, sentence: 'A decision about starting this item is on record.' });
    const kind = describeStartDecision(facts({ outcome: 'asked', decision_type: 'start_new_thing', preset: 'wild', decided_by: null, decided_at: null }));
    expect(kind.sentence).toBe('Waiting for an owner or admin to answer in Needs you: your start setting asks before this kind of work starts.');
    expect(describeStartDecision(facts({ preset: 'wild' })).sentence).toBe('Started automatically under your start setting. No one had to answer.');
    for (const d of [odd, kind]) expect(d.sentence).not.toMatch(/start_|brand_new|wild|null|undefined/);
  });
});

describe('readStartDecision (the item\'s gate row) [pg]', () => {
  const INVOKER_LOGIN = 'fx_start_decision_test';
  let adminPool: Pool;
  let admin: PoolClient;
  let receiptPool: Pool;
  let appPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;
  let person: string;

  async function item(t: SeedRefs): Promise<string> {
    return (await admin.query<{ id: string }>(`INSERT INTO work_items (account_id, repo_id, kind, provenance, title) VALUES ($1, $2, 'issue', 'internal', 'Fix it') RETURNING id`, [t.accountId, t.repoId])).rows[0]!.id;
  }
  const read = (t: SeedRefs, wi: string) => withTenant(appPool, t.accountId, t.userId, (c) => readStartDecision(c, wi));

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
    person = randomUUID();
    await admin.query(`INSERT INTO users (id, email, name) VALUES ($1, $2, 'Ada Lovelace')`, [person, `${person}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'admin')`, [a.accountId, person]);
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), receiptPool.end(), appPool.end()]);
  });

  const gate = (t: SeedRefs) => ({ pool: receiptPool, accountId: t.accountId });

  it('an item that never went through the gate has no start decision', async () => {
    expect(await read(a, await item(a))).toBeNull();
  });

  it('an open ask, then the person\'s answer: waiting, then started by them by name', async () => {
    const wi = await item(a);
    const { askId } = await raiseStartAsk(gate(a), { workItemId: wi, decisionType: 'start_work_small', preset: 'cautious' });
    expect(await read(a, wi)).toMatchObject({ state: 'asked', by: null, at: null, sentence: expect.stringContaining('Waiting for an owner or admin to answer in Needs you: your Cautious setting asks before a small piece of work starts') });
    await answerAsk({ pool: receiptPool, principal: { accountId: a.accountId, userId: person } }, { askId: askId!, choice: 'start' });
    expect(await read(a, wi)).toMatchObject({ state: 'started', by: 'person', name: 'Ada Lovelace', sentence: 'Started by Ada Lovelace.' });
  });

  it('a hold by a person reads as held, by name', async () => {
    const wi = await item(a);
    const { askId } = await raiseStartAsk(gate(a), { workItemId: wi, decisionType: 'start_work_doc', preset: 'cautious' });
    await answerAsk({ pool: receiptPool, principal: { accountId: a.accountId, userId: person } }, { askId: askId!, choice: 'hold' });
    expect(await read(a, wi)).toMatchObject({ state: 'declined', by: 'person', name: 'Ada Lovelace', sentence: 'Held by Ada Lovelace. It does not start until a person starts it.' });
  });

  it('a start under the dial reads as automatic, with the setting, and a click on a feature reads as a person', async () => {
    const small = await item(a);
    await recordStartReceipt(gate(a), { workItemId: small, decisionType: 'start_work_small', preset: 'balanced' });
    expect(await read(a, small)).toMatchObject({ state: 'started', by: 'dial', name: null, sentence: 'Started automatically under your Balanced setting. No one had to answer.' });
    const feature = await item(a);
    await recordStartReceipt({ ...gate(a), userId: person }, { workItemId: feature, decisionType: 'start_parent_item', preset: 'cautious' });
    expect(await read(a, feature)).toMatchObject({ state: 'started', by: 'person', name: 'Ada Lovelace' });
  });

  describe('several gate rows on one item: an open ask always wins', () => {
    /** A row written directly (the admin pool), so created_at / decided_at can be set to any order. */
    async function row(wi: string, type: string, outcome: 'asked' | 'started', created: string, decided: string | null) {
      await admin.query(
        `INSERT INTO start_gate (account_id, work_item_id, decision_type, preset, dial_version, outcome, ask_id, receipt_id, decided_by, decided_at, created_at)
         VALUES ($1, $2, $3, 'cautious', 0, $4, $5, $6, $7, $8, $9)`,
        [a.accountId, wi, type, outcome, outcome === 'asked' ? randomUUID() : null, outcome === 'started' ? randomUUID() : null, outcome === 'started' ? person : null, decided, created],
      );
    }
    const waiting = { state: 'asked', by: null, at: null, sentence: expect.stringContaining('Waiting for an owner or admin') };

    it('(a) a decided small start followed by a later open reclassify ask shows waiting', async () => {
      const wi = await item(a);
      await row(wi, 'start_work_small', 'started', '2026-10-20T10:00:00Z', '2026-10-20T10:01:00Z');
      await row(wi, 'start_after_reclassify', 'asked', '2026-10-21T10:00:00Z', null);
      expect(await read(a, wi)).toMatchObject(waiting);
    });

    it('(b) an open reclassify ask raised first, then a later person-started feature, still shows waiting', async () => {
      const wi = await item(a);
      await row(wi, 'start_after_reclassify', 'asked', '2026-10-20T10:00:00Z', null);
      await row(wi, 'start_parent_item', 'started', '2026-10-22T10:00:00Z', '2026-10-22T10:01:00Z');
      expect(await read(a, wi)).toMatchObject(waiting);
    });

    it('(c) a row asked again the way start_gate_reopen leaves it (decided_at NULL, old created_at) beats a later-decided row of another type', async () => {
      const wi = await item(a);
      // The shape start_gate_reopen leaves: outcome asked, decided_at NULL, created_at long ago. Another type was decided later than it was created.
      await row(wi, 'start_work_small', 'asked', '2026-10-01T10:00:00Z', null);
      await row(wi, 'start_work_bug', 'started', '2026-10-23T10:00:00Z', '2026-10-23T10:01:00Z');
      expect(await read(a, wi)).toMatchObject(waiting);
    });
  });

  it('never shows another account\'s gate row', async () => {
    const wi = await item(a);
    await recordStartReceipt(gate(a), { workItemId: wi, decisionType: 'start_work_bug', preset: 'autonomous' });
    expect(await read(b, wi)).toBeNull();
  });
});
