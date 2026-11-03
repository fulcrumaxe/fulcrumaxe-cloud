import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { defaultModelFor, pricedModelOf, streamTurn } from '../src/index.js';
import { baseParams, chatTurnChunks, fakeKey, startWorld, turnEvents } from './helpers/streamWorld.js';

describe('streamTurn Stop signal and the priced-model mapping (D#597 CC-5e)', () => {
  let w: Awaited<ReturnType<typeof startWorld>>;
  beforeAll(async () => (w = await startWorld()));
  afterAll(async () => w.stop());
  afterEach(() => {
    expect(w.providers.refused()).toEqual([]);
    w.reset();
  });

  it('aborting the caller\'s signal mid-stream ends the read like a deadline: the text so far, incomplete, endedBy deadline, no throw', async () => {
    const t = await w.tenant(fakeKey('api03', 'stop'));
    w.messages.replies.push({ kind: 'stream', events: turnEvents({ text: ['so far'] }).slice(0, 4), endless: true });
    const stop = new AbortController();
    const seen: string[] = [];
    const run = streamTurn(t.ctx, { ...baseParams, timeoutMs: 20_000, signal: stop.signal, onText: (d) => (seen.push(d), stop.abort()) });
    const r = await run;
    expect(seen).toEqual(['so far']);
    expect(r).toMatchObject({ text: 'so far', incomplete: true, endedBy: 'deadline', toolCalls: [] });
  });

  it('a signal already aborted sends nothing useful and fails with a fixed code, not a raw error', async () => {
    const t = await w.tenant(fakeKey('api03', 'prestop'));
    w.messages.replies.push({ kind: 'stream', events: turnEvents({ text: ['x'] }) });
    const stop = new AbortController();
    stop.abort();
    await expect(streamTurn(t.ctx, { ...baseParams, signal: stop.signal })).rejects.toMatchObject({ name: 'ModelCallError' });
  });

  it('R-597-C3-2: a finished Anthropic stream that reports no usage is metered at the worst case and flagged; one that reports it is not', async () => {
    const t = await w.tenant(fakeKey('api03', 'nousage'));
    const bare = JSON.parse(JSON.stringify(turnEvents({ text: ['hi'] }))) as Array<{ data: { message?: { usage?: unknown }; usage?: unknown } }>;
    for (const e of bare) {
      if (e.data.message) delete e.data.message.usage;
      delete e.data.usage;
    }
    w.messages.replies.push({ kind: 'stream', events: bare as never });
    const r = await streamTurn(t.ctx, { ...baseParams, maxOutputTokens: 777 });
    expect(r).toMatchObject({ incomplete: false, usageEstimated: true, usage: { outputTokens: 777 } });
    expect(r.usage.inputTokens).toBeGreaterThan(1500);
    w.messages.replies.push({ kind: 'stream', events: turnEvents({ text: ['hi'], inputTokens: 5, outputTokens: 6 }) });
    const ok = await streamTurn(t.ctx, baseParams);
    expect(ok.usageEstimated).toBeUndefined();
    expect(ok.usage).toEqual({ inputTokens: 5, outputTokens: 6 });
  });

  it('onToolInput sees every fragment of a tool call\'s input as it streams (both shapes)', async () => {
    const g = await w.tenant(fakeKey('api03', 'toolgw'), 'ai_gateway');
    w.chat.replies.push({ kind: 'stream', chunks: chatTurnChunks({ tools: [{ id: 'call_1', name: 'read_item', input: { id: 'abcdef' } }] }) });
    const gseen: string[] = [];
    await streamTurn(g.ctx, { ...baseParams, model: 'anthropic/claude-sonnet-5', onToolInput: (f) => gseen.push(f) });
    expect(gseen.join('')).toBe('{"id":"abcdef"}');
    const t = await w.tenant(fakeKey('api03', 'toolin'));
    w.messages.replies.push({ kind: 'stream', events: turnEvents({ tools: [{ id: 'toolu_1', name: 'read_item', input: { id: 'abcdef' } }] }) });
    const seen: string[] = [];
    await streamTurn(t.ctx, { ...baseParams, onToolInput: (f) => seen.push(f) });
    expect(seen.join('')).toBe('{"id":"abcdef"}');
    expect(seen.length).toBeGreaterThan(1);
  });

  it('maps each provider\'s default and named ids to one plan-data price key, and an unknown id to null', () => {
    expect(defaultModelFor('ai_gateway')).toBe('anthropic/claude-sonnet-5.5');
    expect(defaultModelFor('anthropic')).toBe('claude-sonnet-5-5');
    expect(defaultModelFor('openai')).toBeNull();
    expect(pricedModelOf('ai_gateway', 'anthropic/claude-sonnet-5.5')).toBe('sonnet-5.5');
    expect(pricedModelOf('anthropic', 'claude-sonnet-5-5')).toBe('sonnet-5.5');
    expect(pricedModelOf('anthropic', 'claude-sonnet-5')).toBe('sonnet-5');
    expect(pricedModelOf('anthropic', 'anthropic/claude-sonnet-5.5')).toBeNull();
    expect(pricedModelOf('ai_gateway', 'claude-sonnet-5-5')).toBeNull();
    expect(pricedModelOf('anthropic', 'constructor')).toBeNull();
    expect(pricedModelOf('openai', 'gpt-5')).toBeNull();
  });
});
