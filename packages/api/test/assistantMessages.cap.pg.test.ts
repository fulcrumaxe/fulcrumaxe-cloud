import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MAX_TOOL_ROUNDS, STATE_TEXT } from '../src/assistant/turn.js';
import { chatTurnChunks, planData, startWorld, turnEvents, usePlanData, type Person } from './helpers/assistantWorld.js';

/** Test rates are whole numbers per token (see assistantWorld.ts): 7 micro-USD in, 13 out. A call using 1,000 in and 2,048 out costs this much. */
const REAL_COST = 1000 * 7 + 2048 * 13;

/** D#597 CC-5e: the money rules through the route, on real Postgres: the cap, two tabs at once, the tool-round bound, and Stop. */
describe('assistant messages: spend, rounds and Stop', () => {
  const saved = process.env.FX_PLAN_DATA;
  let w: Awaited<ReturnType<typeof startWorld>>;
  beforeAll(async () => (w = await startWorld()));
  afterEach(() => {
    expect(w.providers.ai_gateway.refused).toEqual([]);
    expect(w.providers.anthropic.refused).toEqual([]);
    w.reset();
  });
  afterAll(async () => {
    usePlanData(saved === undefined ? undefined : JSON.parse(saved));
    await w.stop();
  });
  const chat = () => w.providers.ai_gateway.chat;
  const spendTurn = () => chat().replies.push({ kind: 'stream', chunks: chatTurnChunks({ text: ['ok'], promptTokens: 1000, completionTokens: 2048 }) });
  const turn = (p: Person, conversationId: string | undefined) => ({
    ...(conversationId ? { conversation_id: conversationId } : { repo_id: p.repoId }),
    messages: [{ role: 'user', content: 'and now?' }],
  });

  it('CC-5-4: a conversation that crosses its cap stops with budget_reached, spent never passes the cap, and the refused turn makes no provider call', async () => {
    usePlanData(planData({ cap: 0.1 }));
    const p = await w.person();
    spendTurn();
    const first = (await w.send(p, turn(p, undefined))).json();
    expect(first).toMatchObject({ state: 'ok', spent_micro_usd: REAL_COST, cap_micro_usd: 100_000 });
    spendTurn();
    const second = (await w.send(p, turn(p, first.conversation_id))).json();
    expect(second).toMatchObject({ state: 'ok', spent_micro_usd: 2 * REAL_COST });
    expect(w.calls()).toBe(2);
    // The third turn's worst case no longer fits under $0.10: refused before any call.
    const third = await w.send(p, turn(p, first.conversation_id));
    expect(third.json()).toMatchObject({ state: 'budget_reached', text: STATE_TEXT.budget_reached, spent_micro_usd: 2 * REAL_COST, cap_micro_usd: 100_000 });
    expect(w.calls()).toBe(2);
    expect(await w.conversation(first.conversation_id)).toMatchObject({ spent: 2 * REAL_COST, reserved: 0, turns: 2 });
    expect((await w.conversation(first.conversation_id)).spent).toBeLessThanOrEqual(100_000);
  });

  it('CC-5-8: a small cap admits one of two turns sent at once from two tabs; the other is refused with no provider call, and spent stays under the cap', async () => {
    // Calibrate: the held worst case of one small turn, read from the database while the provider is held back.
    usePlanData(planData({ cap: 2 }));
    const probe = await w.person();
    let open!: () => void;
    w.gate.wait = new Promise<void>((resolve) => (open = resolve));
    chat().replies.push({ kind: 'stream', chunks: chatTurnChunks({ text: ['hi'], promptTokens: 10, completionTokens: 10 }) });
    const probing = w.send(probe, turn(probe, undefined));
    let hold = 0;
    for (let i = 0; i < 300 && hold === 0; i++) {
      hold = (await w.admin.query(`SELECT reserved_micro_usd::int AS r FROM assistant_conversations WHERE account_id = $1`, [probe.accountId])).rows[0]?.r ?? 0;
      if (hold === 0) await new Promise((r) => setTimeout(r, 10));
    }
    open();
    await probing;
    w.reset();
    // A cap of one and a half holds: one turn fits, two at once do not.
    usePlanData(planData({ cap: Math.ceil(hold * 1.5) / 1_000_000 }));
    const p = await w.person();
    chat().replies.push({ kind: 'stream', chunks: chatTurnChunks({ text: ['hi'], promptTokens: 10, completionTokens: 10 }) });
    const start = (await w.send(p, turn(p, undefined))).json();
    expect(start).toMatchObject({ state: 'ok', spent_micro_usd: 10 * 7 + 10 * 13 });
    // Tab A is admitted and held at the provider; tab B asks while A's worst case is reserved.
    let release!: () => void;
    w.gate.wait = new Promise<void>((resolve) => (release = resolve));
    chat().replies.push({ kind: 'stream', chunks: chatTurnChunks({ text: ['A'], promptTokens: 10, completionTokens: 10 }) });
    const tabA = w.send(p, turn(p, start.conversation_id));
    for (let i = 0; i < 300 && (await w.conversation(start.conversation_id)).reserved === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect((await w.conversation(start.conversation_id)).reserved).toBeGreaterThan(0);
    const tabB = (await w.send(p, turn(p, start.conversation_id))).json();
    expect(tabB).toMatchObject({ state: 'budget_reached' });
    expect(chat().calls).toHaveLength(1); // the first turn's call is on the log only once A has been let through
    release();
    expect((await tabA).json()).toMatchObject({ state: 'ok', text: 'A' });
    expect(w.calls()).toBe(2); // the first turn and tab A: tab B made none
    const row = await w.conversation(start.conversation_id);
    expect(row.spent).toBeLessThanOrEqual(row.cap);
    expect(row).toMatchObject({ reserved: 0, turns: 2 });
  });

  it('the tool rounds are bounded: a model that asks for a tool every time stops after the fixed number of calls with tool_limit', async () => {
    usePlanData(planData({ cap: 2 }));
    const p = await w.person();
    for (let i = 0; i <= MAX_TOOL_ROUNDS + 1; i++) chat().replies.push({ kind: 'stream', chunks: chatTurnChunks({ tools: [{ id: `call_${i}`, name: 'get_plan', input: {} }] }) });
    const r = (await w.send(p, turn(p, undefined))).json();
    expect(r).toMatchObject({ state: 'tool_limit', text: STATE_TEXT.tool_limit });
    expect(w.calls()).toBe(MAX_TOOL_ROUNDS + 1);
    expect(await w.conversation(r.conversation_id)).toMatchObject({ reserved: 0, turns: MAX_TOOL_ROUNDS + 1 });
  });

  it('Stop mid-stream (Anthropic): aborting ends the stream, reports stopped, and settles the provider\'s input count plus the output seen, with nothing left held', async () => {
    usePlanData(planData({ cap: 2 }));
    const p = await w.person({ provider: 'anthropic' });
    const m = w.providers.anthropic.messages;
    m.replies.push({ kind: 'stream', events: turnEvents({ text: ['a', 'b', 'c'], inputTokens: 100 }).slice(0, 6), endless: true });
    const stop = new AbortController();
    const sent = w.send(p, turn(p, undefined), { signal: stop.signal });
    for (let i = 0; i < 300 && m.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 100)); // let the first text arrive
    expect(m.calls).toHaveLength(1);
    stop.abort();
    const r = (await sent).json();
    expect(r.state).toBe('stopped');
    expect(await w.conversation(r.conversation_id)).toMatchObject({ reserved: 0, turns: 1, spent: 100 * 7 + 2 * 13 });
  });

  /** The held worst case of one gateway turn, read from the database while the provider holds the request open. */
  const heldWhile = async (accountId: string, open: () => boolean) => {
    let r = 0;
    for (let i = 0; i < 300 && (r === 0 || !open()); i++) {
      r = (await w.admin.query(`SELECT reserved_micro_usd::int AS r FROM assistant_conversations WHERE account_id = $1`, [accountId])).rows[0]?.r ?? 0;
      if (r === 0 || !open()) await new Promise((x) => setTimeout(x, 10));
    }
    return r;
  };

  it('Stop mid-stream (gateway, no usage chunk yet): the provider request is aborted, the turn ends stopped, and the held worst case is settled with nothing left held', async () => {
    usePlanData(planData({ cap: 2 }));
    const p = await w.person();
    chat().replies.push({ kind: 'stream', chunks: chatTurnChunks({ text: ['a', 'b'] }).slice(0, 3), endless: true });
    const stop = new AbortController();
    const sent = w.send(p, turn(p, undefined), { signal: stop.signal });
    const held = await heldWhile(p.accountId, () => chat().calls.length === 1);
    await new Promise((x) => setTimeout(x, 100)); // let the text arrive
    expect(held).toBeGreaterThan(0);
    stop.abort();
    const r = (await sent).json();
    expect(r).toMatchObject({ state: 'stopped', text: `ab${STATE_TEXT.stopped}` }); // the text streamed before Stop, then the fixed word
    expect(chat().hangups).toBe(1);
    expect(await w.conversation(r.conversation_id)).toMatchObject({ reserved: 0, turns: 1, spent: held });
    expect(r.spent_micro_usd).toBe(held);
  });

  it('a gateway stream with no usage chunk that finishes normally is metered at the held worst case, never the input estimate', async () => {
    usePlanData(planData({ cap: 2 }));
    const p = await w.person();
    let open!: () => void;
    w.gate.wait = new Promise<void>((resolve) => (open = resolve));
    chat().replies.push({ kind: 'stream', chunks: chatTurnChunks({ text: ['done'], noUsage: true }) });
    const sent = w.send(p, turn(p, undefined));
    const held = await heldWhile(p.accountId, () => true);
    open();
    const r = (await sent).json();
    expect(r).toMatchObject({ state: 'ok', text: 'done', spent_micro_usd: held });
    expect(held).toBeGreaterThan(2048 * 13); // at least the full output allowance
    expect(await w.conversation(r.conversation_id)).toMatchObject({ reserved: 0, spent: held });
    expect(held).toBeLessThanOrEqual(r.cap_micro_usd);
  });

  it('Stop before the provider answers (gateway): the request never completes and the held worst case is settled, nothing left held', async () => {
    usePlanData(planData({ cap: 2 }));
    const p = await w.person();
    let release!: () => void;
    w.gate.wait = new Promise<void>((resolve) => (release = resolve));
    chat().replies.push({ kind: 'stream', chunks: chatTurnChunks({ text: ['late'] }) });
    const stop = new AbortController();
    const sent = w.send(p, turn(p, undefined), { signal: stop.signal });
    const held = await heldWhile(p.accountId, () => true);
    stop.abort();
    release();
    const r = (await sent).json();
    expect(r).toMatchObject({ state: 'stopped', text: STATE_TEXT.stopped });
    expect(await w.conversation(r.conversation_id)).toMatchObject({ reserved: 0, spent: held });
  });

  it('the Anthropic shape settles real usage from message_delta', async () => {
    usePlanData(planData({ cap: 2 }));
    const p = await w.person({ provider: 'anthropic' });
    w.providers.anthropic.messages.replies.push({ kind: 'stream', events: turnEvents({ text: ['hi'], inputTokens: 500, outputTokens: 40 }) });
    const r = (await w.send(p, turn(p, undefined))).json();
    expect(r).toMatchObject({ state: 'ok', spent_micro_usd: 500 * 7 + 40 * 13 });
  });
});
