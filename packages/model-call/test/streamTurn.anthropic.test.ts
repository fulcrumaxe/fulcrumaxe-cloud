import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { streamTurn } from '../src/index.js';
import { baseParams, fakeKey, startWorld, turnEvents } from './helpers/streamWorld.js';

describe('streamTurn, Anthropic shape, over the strict TLS fake', () => {
  let w: Awaited<ReturnType<typeof startWorld>>;
  beforeAll(async () => (w = await startWorld()));
  afterAll(async () => w.stop());
  afterEach(() => {
    expect(w.providers.refused()).toEqual([]);
    w.reset();
    vi.unstubAllEnvs();
  });

  it('CC-5a-1: two text deltas and one tool-use block come back in order with the parsed input and usage', async () => {
    const t = await w.tenant(fakeKey('api03', 'one'));
    w.messages.replies.push({ kind: 'stream', events: turnEvents({ text: ['Hel', 'lo'], tools: [{ id: 'toolu_01', name: 'read_item', input: { id: 'wi_42', note: 'a "quoted" {brace}' } }], inputTokens: 31, outputTokens: 17 }) });
    const seen: string[] = [];
    const r = await streamTurn(t.ctx, { ...baseParams, onText: (d) => seen.push(d) });
    expect(seen).toEqual(['Hel', 'lo']);
    expect(r).toEqual({
      text: 'Hello',
      toolCalls: [{ id: 'toolu_01', name: 'read_item', input: { id: 'wi_42', note: 'a "quoted" {brace}' } }],
      stopReason: 'tool_use',
      usage: { inputTokens: 31, outputTokens: 17 },
      incomplete: false,
      rejectedCalls: [],
      endedBy: null,
    });
  });

  it('the request is what the real API wants: constant host, SNI, key and version headers, a User-Agent, stream:true, the tools, redirects refused', async () => {
    const key = fakeKey('api03', 'shape');
    const t = await w.tenant(key);
    w.messages.replies.push({ kind: 'stream', events: turnEvents({ text: ['ok'] }) });
    await streamTurn(t.ctx, { ...baseParams, model: 'claude-test-model' });
    const [seen] = w.providers.anthropic.seen;
    expect(seen).toMatchObject({ method: 'POST', path: '/v1/messages', servername: 'api.anthropic.com' });
    const call = w.messages.calls[0]!;
    expect(call.refusal).toBeNull();
    expect(call.headers).toMatchObject({ 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' });
    expect(call.headers['user-agent']).toMatch(/^fulcrumaxe-cloud/);
    expect(JSON.parse(call.bodyText)).toMatchObject({ model: 'claude-test-model', max_tokens: 1024, stream: true, tools: baseParams.tools });
  });

  it('a text-only turn has no tool calls and omits "tools" when none are given', async () => {
    const t = await w.tenant(fakeKey('api03', 'plain'));
    w.messages.replies.push({ kind: 'stream', events: turnEvents({ text: ['just text'] }) });
    const r = await streamTurn(t.ctx, { ...baseParams, tools: [] });
    expect(r).toMatchObject({ text: 'just text', toolCalls: [], stopReason: 'end_turn', incomplete: false });
    expect(JSON.parse(w.messages.calls[0]!.bodyText)).not.toHaveProperty('tools');
  });

  it('a tool-result turn that answers the earlier tool_use passes the fake', async () => {
    const t = await w.tenant(fakeKey('api03', 'result'));
    w.messages.replies.push({ kind: 'stream', events: turnEvents({ text: ['done'] }) });
    const messages = [
      { role: 'user' as const, content: 'look it up' },
      { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: 'toolu_01', name: 'read_item', input: { id: 'wi_42' } }] },
      { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 'toolu_01', content: '{"title":"x"}' }] },
    ];
    expect((await streamTurn(t.ctx, { ...baseParams, messages })).text).toBe('done');
    expect(w.messages.calls[0]!.refusal).toBeNull();
  });

  it('CC-5a-7: FX_FORBID_MODEL_CALLS still refuses the real transport, before the database or network', async () => {
    vi.stubEnv('FX_FORBID_MODEL_CALLS', '1');
    const t = await w.tenant(fakeKey('api03', 'forbid'));
    await expect(streamTurn({ ...t.ctx, fetchImpl: undefined }, baseParams)).rejects.toMatchObject({ code: 'forbidden' });
    expect(w.providers.seen()).toEqual([]);
  });
});
