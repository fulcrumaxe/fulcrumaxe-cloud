import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MAX_OUTPUT_TOKENS, STATE_TEXT, settledUsage } from '../src/assistant/turn.js';
import { chatTurnChunks, planData, startWorld, turnEvents, usePlanData, type Person } from './helpers/assistantWorld.js';

/**
 * D#597 CC-5e, R-597-C3-1 and C3-2: the hold is a true ceiling, and every turn that ends without a clean count settles an amount that cannot
 * understate what the person's key was charged. Real Postgres and the strict provider fakes; rates are whole numbers (7 in, 13 out, 9 cache-write).
 */
describe('assistant messages: the hold is a ceiling and incomplete turns settle at the worst case', () => {
  const saved = process.env.FX_PLAN_DATA;
  let w: Awaited<ReturnType<typeof startWorld>>;
  const chat = () => w.providers.ai_gateway.chat;
  const msgs = () => w.providers.anthropic.messages;
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
  const turn = (p: Person) => ({ repo_id: p.repoId, messages: [{ role: 'user', content: 'and now?' }] });
  const script = (provider: 'ai_gateway' | 'anthropic', o: { text?: string[]; prompt?: number; completion?: number; noUsage?: boolean; cutAfter?: number }) => {
    if (provider === 'anthropic') {
      let events = turnEvents({ text: o.text ?? ['ok'], inputTokens: o.prompt ?? 10, outputTokens: o.completion ?? 10 });
      if (o.noUsage) {
        events = JSON.parse(JSON.stringify(events));
        for (const e of events) {
          const d = e.data as { message?: { usage?: unknown }; usage?: unknown };
          if (d.message) delete d.message.usage;
          delete d.usage;
        }
      }
      msgs().replies.push({ kind: 'stream', events, ...(o.cutAfter ? { cutAfter: o.cutAfter } : {}) });
    } else {
      chat().replies.push({ kind: 'stream', chunks: chatTurnChunks({ text: o.text ?? ['ok'], promptTokens: o.prompt ?? 10, completionTokens: o.completion ?? 10, ...(o.noUsage ? { noUsage: true } : {}) }), ...(o.cutAfter ? { cutAfter: o.cutAfter } : {}) });
    }
  };
  /** Sends a turn with the provider held back, reads the reserved worst case from the database, then lets it through. */
  async function gated(p: Person, body: unknown) {
    let open!: () => void;
    w.gate.wait = new Promise<void>((resolve) => (open = resolve));
    const sent = w.send(p, body);
    let held = 0;
    for (let i = 0; i < 300 && held === 0; i++) {
      held = (await w.admin.query(`SELECT reserved_micro_usd::int AS r FROM assistant_conversations WHERE account_id = $1`, [p.accountId])).rows[0]?.r ?? 0;
      if (held === 0) await new Promise((r) => setTimeout(r, 10));
    }
    w.gate.wait = null;
    open();
    return { held, res: await sent };
  }
  const bodyBytes = (provider: 'ai_gateway' | 'anthropic') => (provider === 'anthropic' ? msgs().calls : chat().calls).at(-1)!.bodyText.length;

  it.each(['ai_gateway', 'anthropic'] as const)('R-597-C3-1 (%s): with the cap equal to the hold, a provider reporting bytes/4 + 1,500 prompt tokens and the full completion leaves spent at or under the cap', async (provider) => {
    usePlanData(planData({ cap: 2 }));
    const probe = await w.person({ provider });
    script(provider, {});
    const { held } = await gated(probe, turn(probe));
    expect(held).toBeGreaterThan(MAX_OUTPUT_TOKENS * 13 + 1500 * 9); // the tool preamble and the full output allowance are both in it
    const prompt = Math.floor(bodyBytes(provider) / 4) + 1500;
    w.reset();
    usePlanData(planData({ cap: held / 1_000_000 }));
    const p = await w.person({ provider });
    script(provider, { prompt, completion: MAX_OUTPUT_TOKENS });
    const r = (await w.send(p, turn(p))).json();
    expect(r).toMatchObject({ state: 'ok', cap_micro_usd: held, spent_micro_usd: prompt * 7 + MAX_OUTPUT_TOKENS * 13 });
    expect(r.spent_micro_usd).toBeLessThanOrEqual(r.cap_micro_usd);
    expect(await w.conversation(r.conversation_id)).toMatchObject({ reserved: 0 });
  });

  it.each(['ai_gateway', 'anthropic'] as const)('R-597-C3-2 (%s): a cut connection settles the held worst case, not a formula', async (provider) => {
    usePlanData(planData({ cap: 2 }));
    const p = await w.person({ provider });
    script(provider, { text: ['a', 'b', 'c'], cutAfter: 4 });
    const { held, res } = await gated(p, turn(p));
    const r = res.json();
    expect(r.state).toBe('incomplete');
    expect(r.spent_micro_usd).toBe(held);
    expect(await w.conversation(r.conversation_id)).toMatchObject({ reserved: 0, spent: held });
  });

  it.each(['ai_gateway', 'anthropic'] as const)('R-597-C3-2 (%s): a finished stream with no usage is metered at the held worst case', async (provider) => {
    usePlanData(planData({ cap: 2 }));
    const p = await w.person({ provider });
    script(provider, { text: ['done'], noUsage: true });
    const { held, res } = await gated(p, turn(p));
    const r = res.json();
    expect(r).toMatchObject({ state: 'ok', text: 'done' });
    expect(r.spent_micro_usd).toBe(held);
    expect(held).toBeLessThanOrEqual(r.cap_micro_usd);
  });

  it('R-597-C3-2: Stop while the model writes a long tool input counts those bytes (Anthropic)', async () => {
    usePlanData(planData({ cap: 2 }));
    const p = await w.person({ provider: 'anthropic' });
    const fragments = ['{"item_id":"00000000-0000-4000-8000-000000000001","kind":"question","body":"', ...Array.from({ length: 26 }, () => 'a'.repeat(100))];
    const toolBytes = fragments.reduce((n, f) => n + f.length, 0);
    const events = [
      ...turnEvents({ inputTokens: 100 }).slice(0, 1),
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'draft_correction', input: {} } } },
      ...fragments.map((f) => ({ event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: f } } })),
    ];
    msgs().replies.push({ kind: 'stream', events, endless: true });
    const stop = new AbortController();
    const sent = w.send(p, turn(p), { signal: stop.signal });
    for (let i = 0; i < 300 && msgs().calls.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 300)); // every fragment has arrived
    stop.abort();
    const r = (await sent).json();
    expect(r).toMatchObject({ state: 'stopped', text: STATE_TEXT.stopped });
    // The input count, plus half a token per byte of the tool input: not the one token the text alone would give.
    expect(r.spent_micro_usd).toBe(100 * 7 + Math.ceil(toolBytes / 2) * 13);
    expect(await w.conversation(r.conversation_id)).toMatchObject({ reserved: 0 });
  });

  it('settledUsage: cut, size_cap and a timeout settle the worst case (null); a Stop is measured; no usage is the worst case; a clean count is kept', () => {
    const base = { usage: { inputTokens: 100, outputTokens: 1 }, text: 'abcd' };
    expect(settledUsage({ ...base, endedBy: 'cut' }, 0, false, 5)).toBeNull();
    expect(settledUsage({ ...base, endedBy: 'cut' }, 0, true, 5)).toBeNull();
    expect(settledUsage({ ...base, endedBy: 'size_cap' }, 0, true, 5)).toBeNull();
    expect(settledUsage({ ...base, endedBy: 'deadline' }, 0, false, 5)).toBeNull(); // the model timeout, not a Stop
    expect(settledUsage({ ...base, endedBy: null, usageEstimated: true }, 0, false, 5)).toBeNull();
    expect(settledUsage({ ...base, endedBy: null }, 0, false, 5)).toEqual(base.usage);
    expect(settledUsage({ ...base, endedBy: 'deadline' }, 2000, true, 5)).toEqual({ inputTokens: 100, outputTokens: 1002 });
    expect(settledUsage({ ...base, endedBy: 'deadline' }, 10_000_000, true, 5)).toEqual({ inputTokens: 100, outputTokens: MAX_OUTPUT_TOKENS });
    expect(settledUsage({ usage: { inputTokens: 0, outputTokens: 0 }, text: '', endedBy: 'deadline' }, 0, true, 77)).toEqual({ inputTokens: 77, outputTokens: 0 });
  });
});
