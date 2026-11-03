import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { withTenant } from '../src/tenancy/withTenant.js';
import {
  AssistantHoldRefusedError,
  accountAssistantSpend,
  admitTurn,
  getConversation,
  settleTurn,
  startConversation,
  worstCaseMicroUsd,
} from '../src/assistant/conversations.js';
import { planDataWith, restorePlanData, usePlanData } from './assistantConversation.support.js';

/**
 * D#597 CC-5c: the cap, against a real Postgres. Rates in the test data are 7 micro-USD per input token, 13 per output token and 17 per
 * cache-write token, so a turn's worst case prices its input estimate at 17 per token (the dearer of input and cache-write).
 */
describe('assistant conversation cap (D#597 CC-5c)', () => {
  const saved = process.env.FX_PLAN_DATA;
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let a: SeedRefs;
  let userA: string;
  const as = (accountId: string, userId: string) => ({ pool: appPool, principal: { accountId, userId } });

  async function addMember(accountId: string, role: 'admin' | 'member'): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [id, `${id}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [accountId, id, role]);
    return id;
  }
  async function admitOk(ctx: ReturnType<typeof as>, conversationId: string, inputTokensEstimate: number, maxOutputTokens: number) {
    const r = await admitTurn(ctx, { conversationId, model: 'sonnet-5', inputTokensEstimate, maxOutputTokens });
    if (!r.admitted) throw new Error('expected admission');
    return r;
  }

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    a = await seedAccount(admin, randomUUID());
    userA = await addMember(a.accountId, 'member');
    usePlanData(planDataWith(2));
  });
  afterEach(() => usePlanData(planDataWith(2)));
  afterAll(async () => {
    restorePlanData(saved);
    admin.release();
    await Promise.all([adminPool.end(), appPool.end()]);
  });

  const turn = (conversationId: string, outTokens = 60_000) => ({ conversationId, model: 'sonnet-5', inputTokensEstimate: 50_000, maxOutputTokens: outTokens });

  it('prices the worst case with cache-write pricing: input at the dearer of the input and cache-write rates', () => {
    expect(worstCaseMicroUsd('sonnet-5', 1000, 100)).toBe(1000 * 17 + 100 * 13);
    expect(worstCaseMicroUsd('nope', 1, 1)).toBeUndefined();
  });

  it('starts at 0 with the cap fixed at the plan-data value, which later plan-data changes do not move', async () => {
    const c = await startConversation(as(a.accountId, userA), { repoId: a.repoId });
    expect(c).toMatchObject({ capMicroUsd: 2_000_000, spentMicroUsd: 0, reservedMicroUsd: 0, turns: 0, createdBy: userA });
    usePlanData(planDataWith(5));
    expect((await getConversation(as(a.accountId, userA), c.id)).capMicroUsd).toBe(2_000_000);
  });

  it('two turns racing at the cap: exactly one is admitted, and spent plus held never passes the cap', async () => {
    const ctx = as(a.accountId, userA);
    const c = await startConversation(ctx, { repoId: a.repoId });
    // each turn's worst case is 50,000 * 17 + 60,000 * 13 = 1,630,000; two do not fit under 2,000,000
    const results = await Promise.all([admitTurn(ctx, turn(c.id)), admitTurn(ctx, turn(c.id))]);
    expect(results.filter((r) => r.admitted)).toHaveLength(1);
    expect(results.filter((r) => !r.admitted)).toEqual([{ admitted: false, code: 'budget_reached' }]);
    const after = await getConversation(ctx, c.id);
    expect(after.reservedMicroUsd).toBe(1_630_000);
    expect(after.turns).toBe(1);
    expect(after.spentMicroUsd + after.reservedMicroUsd).toBeLessThanOrEqual(after.capMicroUsd);
  });

  it('a forced overlap: the second turn starts while the first holds the row lock, waits, then is refused', async () => {
    const ctx = as(a.accountId, userA);
    const c = await startConversation(ctx, { repoId: a.repoId });
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    let firstCharged!: () => void;
    const charged = new Promise<void>((res) => (firstCharged = res));
    const worst = worstCaseMicroUsd('sonnet-5', 50_000, 60_000)!;
    // connection 1: charge inside a transaction that stays open (holding the conversation's row lock) until the gate opens
    const first = withTenant(appPool, a.accountId, userA, async (client) => {
      const { rows } = await client.query<{ hold: string | null }>('SELECT assistant_conversation_charge($1, $2) AS hold', [c.id, worst]);
      firstCharged();
      await gate;
      return rows[0]!.hold;
    });
    await charged;
    // connection 2: starts now and must block on the lock
    const second = admitTurn(ctx, turn(c.id));
    let waiting = false;
    for (let i = 0; i < 100 && !waiting; i++) {
      const { rows } = await admin.query(
        `SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%assistant_conversation_charge%' AND pid <> pg_backend_pid()`,
      );
      waiting = rows.length > 0;
      if (!waiting) await new Promise((r) => setTimeout(r, 50));
    }
    expect(waiting).toBe(true);
    release();
    expect(await first).not.toBeNull();
    expect(await second).toEqual({ admitted: false, code: 'budget_reached' });
    expect((await getConversation(ctx, c.id)).reservedMicroUsd).toBe(worst);
  });

  it('many racing turns never overspend: ten at 340,000 each admit exactly five', async () => {
    const ctx = as(a.accountId, userA);
    const c = await startConversation(ctx, { repoId: a.repoId });
    const results = await Promise.all(Array.from({ length: 10 }, () => admitTurn(ctx, { conversationId: c.id, model: 'sonnet-5', inputTokensEstimate: 20_000, maxOutputTokens: 0 })));
    expect(results.filter((r) => r.admitted)).toHaveLength(5);
    expect((await getConversation(ctx, c.id)).reservedMicroUsd).toBe(1_700_000);
  });

  it('settling records the priced usage, releases the rest, and frees room for the next turn', async () => {
    const ctx = as(a.accountId, userA);
    const c = await startConversation(ctx, { repoId: a.repoId });
    const first = await admitOk(ctx, c.id, 50_000, 60_000);
    const spent = await settleTurn(ctx, { conversationId: c.id, holdId: first.holdId, model: 'sonnet-5', usage: { inputTokens: 20_000, outputTokens: 2_000 } });
    expect(spent).toBe(20_000 * 7 + 2_000 * 13);
    expect(await getConversation(ctx, c.id)).toMatchObject({ spentMicroUsd: 166_000, reservedMicroUsd: 0 });
    expect((await admitTurn(ctx, turn(c.id))).admitted).toBe(true);
  });

  it('no usage settles at the hold; a conversation stops exactly at the cap', async () => {
    const ctx = as(a.accountId, userA);
    const c = await startConversation(ctx, { repoId: a.repoId });
    const t = await admitOk(ctx, c.id, 1000, 1000); // held 17,000 + 13,000 = 30,000
    expect(await settleTurn(ctx, { conversationId: c.id, holdId: t.holdId, model: 'sonnet-5', usage: { inputTokens: 1000, outputTokens: 1000 } })).toBe(20_000);
    const u = await admitOk(ctx, c.id, 1000, 1000);
    expect(await settleTurn(ctx, { conversationId: c.id, holdId: u.holdId, model: 'sonnet-5', usage: null })).toBe(50_000);
    // 1,950,000 is left (150,000 output tokens); one more token does not fit, 150,000 does
    expect(await admitTurn(ctx, { conversationId: c.id, model: 'sonnet-5', inputTokensEstimate: 0, maxOutputTokens: 150_001 })).toEqual({ admitted: false, code: 'budget_reached' });
    expect((await admitTurn(ctx, { conversationId: c.id, model: 'sonnet-5', inputTokensEstimate: 0, maxOutputTokens: 150_000 })).admitted).toBe(true);
    const end = await getConversation(ctx, c.id);
    expect(end.spentMicroUsd + end.reservedMicroUsd).toBe(end.capMicroUsd);
  });

  it('a real cost above the hold is recorded in full, spent passes the cap, and the next turn is refused with budget_reached', async () => {
    const ctx = as(a.accountId, userA);
    const c = await startConversation(ctx, { repoId: a.repoId });
    const t = await admitOk(ctx, c.id, 1000, 1000); // held 30,000
    // 428,572 input tokens at 7 = 3,000,004, far above both the hold and the 2,000,000 cap
    expect(await settleTurn(ctx, { conversationId: c.id, holdId: t.holdId, model: 'sonnet-5', usage: { inputTokens: 428_572, outputTokens: 0 } })).toBe(3_000_004);
    expect(await getConversation(ctx, c.id)).toMatchObject({ spentMicroUsd: 3_000_004, reservedMicroUsd: 0 });
    expect(await admitTurn(ctx, { conversationId: c.id, model: 'sonnet-5', inputTokensEstimate: 1, maxOutputTokens: 0 })).toEqual({ admitted: false, code: 'budget_reached' });
  });

  it('settling the same hold twice is refused and changes nothing', async () => {
    const ctx = as(a.accountId, userA);
    const c = await startConversation(ctx, { repoId: a.repoId });
    const t = await admitOk(ctx, c.id, 1000, 0);
    const settle = () => settleTurn(ctx, { conversationId: c.id, holdId: t.holdId, model: 'sonnet-5', usage: { inputTokens: 500, outputTokens: 0 } });
    expect(await settle()).toBe(3500);
    await expect(settle()).rejects.toBeInstanceOf(AssistantHoldRefusedError);
    expect(await getConversation(ctx, c.id)).toMatchObject({ spentMicroUsd: 3500, reservedMicroUsd: 0 });
  });

  it('two holds in flight: a repeated settle on hold A cannot touch hold B, which still settles correctly', async () => {
    const ctx = as(a.accountId, userA);
    const c = await startConversation(ctx, { repoId: a.repoId });
    const holdA = await admitOk(ctx, c.id, 1000, 0); // 17,000
    const holdB = await admitOk(ctx, c.id, 2000, 0); // 34,000
    expect(await getConversation(ctx, c.id)).toMatchObject({ reservedMicroUsd: 51_000, spentMicroUsd: 0 });
    const settleA = () => settleTurn(ctx, { conversationId: c.id, holdId: holdA.holdId, model: 'sonnet-5', usage: { inputTokens: 500, outputTokens: 0 } });
    expect(await settleA()).toBe(3500);
    await expect(settleA()).rejects.toBeInstanceOf(AssistantHoldRefusedError);
    await expect(settleA()).rejects.toBeInstanceOf(AssistantHoldRefusedError);
    // B's reserve is untouched by the repeats
    expect(await getConversation(ctx, c.id)).toMatchObject({ reservedMicroUsd: 34_000, spentMicroUsd: 3500 });
    expect(await settleTurn(ctx, { conversationId: c.id, holdId: holdB.holdId, model: 'sonnet-5', usage: { inputTokens: 2000, outputTokens: 0 } })).toBe(3500 + 14_000);
    expect(await getConversation(ctx, c.id)).toMatchObject({ reservedMicroUsd: 0, spentMicroUsd: 17_500 });
  });

  it("another conversation's hold, and an unknown hold, are refused with the fixed code and change nothing", async () => {
    const ctx = as(a.accountId, userA);
    const c1 = await startConversation(ctx, { repoId: a.repoId });
    const c2 = await startConversation(ctx, { repoId: a.repoId });
    const h1 = await admitOk(ctx, c1.id, 1000, 0);
    await admitOk(ctx, c2.id, 1000, 0);
    const usage = { inputTokens: 1, outputTokens: 0 };
    await expect(settleTurn(ctx, { conversationId: c2.id, holdId: h1.holdId, model: 'sonnet-5', usage })).rejects.toBeInstanceOf(AssistantHoldRefusedError);
    await expect(settleTurn(ctx, { conversationId: c2.id, holdId: randomUUID(), model: 'sonnet-5', usage })).rejects.toMatchObject({ code: 'assistant_hold_refused' });
    expect(await getConversation(ctx, c1.id)).toMatchObject({ reservedMicroUsd: 17_000, spentMicroUsd: 0 });
    expect(await getConversation(ctx, c2.id)).toMatchObject({ reservedMicroUsd: 17_000, spentMicroUsd: 0 });
  });

  it('a hold unsettled after the 20-minute TTL is released at the next charge; its late settle still books the real cost once and releases no reserve', async () => {
    const ctx = as(a.accountId, userA);
    const c = await startConversation(ctx, { repoId: a.repoId });
    const dead = await admitOk(ctx, c.id, 100_000, 0); // 1,700,000
    expect(await admitTurn(ctx, { conversationId: c.id, model: 'sonnet-5', inputTokensEstimate: 100_000, maxOutputTokens: 0 })).toEqual({ admitted: false, code: 'budget_reached' });
    // a hold only 19 minutes old is still live
    await admin.query(`UPDATE assistant_conversation_holds SET created_at = now() - interval '19 minutes' WHERE hold_id = $1`, [dead.holdId]);
    expect((await admitTurn(ctx, { conversationId: c.id, model: 'sonnet-5', inputTokensEstimate: 100_000, maxOutputTokens: 0 })).admitted).toBe(false);
    await admin.query(`UPDATE assistant_conversation_holds SET created_at = now() - interval '21 minutes' WHERE hold_id = $1`, [dead.holdId]);
    const next = await admitTurn(ctx, { conversationId: c.id, model: 'sonnet-5', inputTokensEstimate: 100_000, maxOutputTokens: 0 });
    expect(next.admitted).toBe(true);
    expect((await getConversation(ctx, c.id)).reservedMicroUsd).toBe(1_700_000);
    const late = () => settleTurn(ctx, { conversationId: c.id, holdId: dead.holdId, model: 'sonnet-5', usage: { inputTokens: 1000, outputTokens: 0 } });
    expect(await late()).toBe(7000);
    // spent includes the actual; reserved is still only the new hold's
    expect(await getConversation(ctx, c.id)).toMatchObject({ spentMicroUsd: 7000, reservedMicroUsd: 1_700_000 });
    await expect(late()).rejects.toBeInstanceOf(AssistantHoldRefusedError);
    expect(await getConversation(ctx, c.id)).toMatchObject({ spentMicroUsd: 7000, reservedMicroUsd: 1_700_000 });
  });

  it('accountAssistantSpend is the sum of the rows plus what is held, and no preview counter moves', async () => {
    const b = await seedAccount(admin, randomUUID());
    const userB = await addMember(b.accountId, 'member');
    const ctx = as(b.accountId, userB);
    const previews = async () => (await admin.query(`SELECT count(*)::int AS n FROM onboarding_previews`)).rows[0].n as number;
    const before = await previews();
    let total = 0;
    for (const input of [4000, 7000]) {
      const c = await startConversation(ctx, { repoId: b.repoId });
      const t = await admitOk(ctx, c.id, input, 100);
      total += await settleTurn(ctx, { conversationId: c.id, holdId: t.holdId, model: 'sonnet-5', usage: { inputTokens: input, outputTokens: 100 } });
    }
    expect(await accountAssistantSpend(ctx)).toEqual({ spentMicroUsd: total, reservedMicroUsd: 0, conversations: 2 });
    expect(total).toBe(4000 * 7 + 100 * 13 + 7000 * 7 + 100 * 13);
    // a turn in flight shows as reserved spend
    const open = await startConversation(ctx, { repoId: b.repoId });
    const h = await admitOk(ctx, open.id, 1000, 0);
    expect(await accountAssistantSpend(ctx)).toEqual({ spentMicroUsd: total, reservedMicroUsd: h.heldMicroUsd, conversations: 3 });
    expect(await accountAssistantSpend(ctx, { since: new Date(Date.now() + 60_000) })).toEqual({ spentMicroUsd: 0, reservedMicroUsd: 0, conversations: 0 });
    expect(await previews()).toBe(before);
  });
});
