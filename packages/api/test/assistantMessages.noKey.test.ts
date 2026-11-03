import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { STATE_TEXT } from '../src/assistant/turn.js';
import { chatTurnChunks, planData, startWorld, turnEvents, usePlanData } from './helpers/assistantWorld.js';

/**
 * D#597 CC-5e: the states that make no model call (CC-5-3 and the TL rulings): no key, no cap in the plan data, and a model with no price row.
 * Each asserts the strict fake's call log is empty and that nothing was held.
 */
describe('assistant messages: states that never reach the provider', () => {
  const saved = process.env.FX_PLAN_DATA;
  let w: Awaited<ReturnType<typeof startWorld>>;
  beforeAll(async () => {
    w = await startWorld();
    usePlanData(planData({ cap: 2 }));
  });
  afterEach(() => {
    expect(w.providers.anthropic.refused).toEqual([]);
    expect(w.providers.ai_gateway.refused).toEqual([]);
    w.reset();
    usePlanData(planData({ cap: 2 }));
  });
  afterAll(async () => {
    usePlanData(saved === undefined ? undefined : JSON.parse(saved));
    await w.stop();
  });
  const say = (p: { repoId: string }) => ({ repo_id: p.repoId, messages: [{ role: 'user', content: 'What is going on?' }] });
  const conversations = async (accountId: string) => (await w.admin.query(`SELECT count(*)::int AS n FROM assistant_conversations WHERE account_id = $1`, [accountId])).rows[0].n as number;

  it('CC-5-3: an account with no model key gets the fixed answer, JSON and stream alike, and no model call and no conversation row', async () => {
    const p = await w.person({ provider: null });
    const json = await w.send(p, say(p));
    expect(json.status).toBe(200);
    expect(json.json()).toEqual({ state: 'no_key', code: 'assistant_no_key', text: 'Add a model key to use the assistant' });
    const stream = await w.send(p, say(p), { stream: true });
    expect(stream.contentType).toContain('text/event-stream');
    expect(stream.events()).toEqual([
      { event: 'text', data: { delta: STATE_TEXT.no_key } },
      { event: 'done', data: { state: 'no_key', code: 'assistant_no_key' } },
    ]);
    expect(w.calls()).toBe(0);
    expect(await conversations(p.accountId)).toBe(0);
  });

  it('with no cap in the plan data the route answers the fixed unavailable state, makes no call and starts no conversation', async () => {
    usePlanData(planData({ cap: null }));
    const p = await w.person();
    const r = await w.send(p, say(p));
    expect(r.json()).toEqual({ state: 'unconfigured', code: 'assistant_unconfigured', text: STATE_TEXT.unconfigured });
    expect(w.calls()).toBe(0);
    expect(await conversations(p.accountId)).toBe(0);
  });

  it.each(['ai_gateway', 'anthropic'] as const)('TL ruling: %s default model with no sonnet-5.5 price row answers unpriced, calls nothing and holds nothing', async (provider) => {
    usePlanData(planData({ cap: 2, priced: false }));
    const p = await w.person({ provider });
    const r = await w.send(p, say(p));
    const body = r.json();
    expect(body).toMatchObject({ state: 'unpriced', code: 'assistant_unpriced', text: STATE_TEXT.unpriced, spent_micro_usd: 0 });
    expect(w.calls()).toBe(0);
    expect(await w.conversation(body.conversation_id)).toMatchObject({ spent: 0, reserved: 0, turns: 0 });
  });

  it.each(['ai_gateway', 'anthropic'] as const)('TL ruling: with the sonnet-5.5 row present, %s makes exactly one call, priced from plan data', async (provider) => {
    const p = await w.person({ provider });
    if (provider === 'anthropic') w.providers.anthropic.messages.replies.push({ kind: 'stream', events: turnEvents({ text: ['Hello'], inputTokens: 1000, outputTokens: 100 }) });
    else w.providers.ai_gateway.chat.replies.push({ kind: 'stream', chunks: chatTurnChunks({ text: ['Hello'], promptTokens: 1000, completionTokens: 100 }) });
    const r = await w.send(p, say(p));
    const body = r.json();
    expect(body).toMatchObject({ state: 'ok', text: 'Hello', spent_micro_usd: 1000 * 7 + 100 * 13 });
    expect(w.calls()).toBe(1);
    expect(await w.conversation(body.conversation_id)).toMatchObject({ spent: 8300, reserved: 0, turns: 1 });
  });

  it('a provider row the assistant cannot stream with answers unavailable and sends nothing', async () => {
    const p = await w.person();
    await w.admin.query(`UPDATE model_connections SET provider = 'openai', credential_kind = 'openai_api_key' WHERE account_id = $1`, [p.accountId]);
    const r = await w.send(p, say(p));
    expect(r.json()).toMatchObject({ state: 'unavailable', code: 'unsupported_provider' });
    expect(w.calls()).toBe(0);
  });
});
