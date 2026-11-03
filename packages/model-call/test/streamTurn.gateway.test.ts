import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ModelCallError, streamTurn } from '../src/index.js';
import { gatewayPricedModel, streamRequestFor } from '../src/hosts.js';
import { TOOL_PREAMBLE_OVERHEAD_TOKENS } from '../src/streamGateway.js';
import { clampStreamBytes } from '../src/streamCore.js';
import { validateChatRequest } from '../../model-connection/test/helpers/gatewayChatFake.js';
import { CREDITS_EXHAUSTED_ANSWERS } from '../../model-connection/test/helpers/creditsAnswers.js';
import { isPriced } from '../../spend/src/tables/index.js';
import { baseParams, chatTurnChunks, fakeKey, startWorld } from './helpers/streamWorld.js';

const gwParams = { ...baseParams, model: 'anthropic/claude-sonnet-5' };
const INPUT = { id: 'wi_é', note: 'quote " brace } comma , \\ end', emoji: '\u{1F600}' };

describe('streamTurn, gateway shape, over the strict TLS fake', () => {
  let w: Awaited<ReturnType<typeof startWorld>>;
  beforeAll(async () => (w = await startWorld()));
  afterAll(async () => w.stop());
  afterEach(() => {
    expect(w.providers.refused()).toEqual([]);
    w.reset();
    vi.restoreAllMocks();
  });
  const gw = (tag: string) => w.tenant(fakeKey('api03', tag), 'ai_gateway');

  it('CC-5b-1: fragmented tool_calls argument deltas assemble into one valid input; text arrives in order', async () => {
    const t = await gw('frag');
    w.chat.replies.push({ kind: 'stream', chunks: chatTurnChunks({ text: ['Hel', 'lo'], tools: [{ id: 'call_1', name: 'read_item', input: INPUT }, { id: 'call_2', name: 'read_item', input: { id: 'b' } }], promptTokens: 31, completionTokens: 17 }) });
    const seen: string[] = [];
    const r = await streamTurn(t.ctx, { ...gwParams, onText: (d) => seen.push(d) });
    expect(seen).toEqual(['Hel', 'lo']);
    expect(r).toEqual({
      text: 'Hello',
      toolCalls: [
        { id: 'call_1', name: 'read_item', input: INPUT },
        { id: 'call_2', name: 'read_item', input: { id: 'b' } },
      ],
      rejectedCalls: [],
      endedBy: null,
      stopReason: 'tool_use',
      usage: { inputTokens: 31, outputTokens: 17 },
      incomplete: false,
    });
  });

  it('CC-5b-1: a truncated argument string yields incomplete and no call (stream cut before finish_reason)', async () => {
    const t = await gw('trunc');
    const chunks = chatTurnChunks({ tools: [{ id: 'call_1', name: 'read_item', input: INPUT }] });
    w.chat.replies.push({ kind: 'stream', chunks, cutAfter: 3 }); // role chunk, tool header, first argument piece
    const r = await streamTurn(t.ctx, gwParams);
    expect(r).toMatchObject({ toolCalls: [], incomplete: true, endedBy: 'cut' });
  });

  it('CC-5b-1: arguments that close as invalid JSON are rejected with a fixed reason and mark the turn incomplete', async () => {
    const t = await gw('badjson');
    const chunks = chatTurnChunks({ tools: [{ id: 'call_1', name: 'read_item', input: { id: 'a' } }] });
    chunks.splice(chunks.length - 3, 0, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{{' } }] }, finish_reason: null }] });
    w.chat.replies.push({ kind: 'stream', chunks });
    const r = await streamTurn(t.ctx, gwParams);
    expect(r.toolCalls).toEqual([]);
    expect(r.rejectedCalls).toEqual([{ code: 'tool_call_rejected', reason: 'input_not_json', index: 0 }]);
    expect(r.incomplete).toBe(true);
  });

  it('a tool that was never offered, and a duplicate id, are dropped as in the Anthropic shape', async () => {
    const t = await gw('vet');
    w.chat.replies.push({ kind: 'stream', chunks: chatTurnChunks({ tools: [{ id: 'c1', name: 'accept_correction', input: {} }, { id: 'c2', name: 'read_item', input: {} }, { id: 'c2', name: 'read_item', input: {} }] }) });
    const r = await streamTurn(t.ctx, gwParams);
    expect(r.toolCalls).toEqual([{ id: 'c2', name: 'read_item', input: {} }]);
    expect(r.rejectedCalls.map((x) => [x.reason, x.index])).toEqual([['unknown_tool', 0], ['duplicate_id', 2]]);
    expect(JSON.stringify(r.rejectedCalls)).not.toContain('accept_correction');
  });

  it('the request is what the gateway wants: constant host, SNI, Bearer, a User-Agent, stream and include_usage, tools as functions', async () => {
    const key = fakeKey('api03', 'shape');
    const t = await w.tenant(key, 'ai_gateway');
    w.chat.replies.push({ kind: 'stream', chunks: chatTurnChunks({ text: ['ok'] }) });
    await streamTurn(t.ctx, { ...baseParams, model: 'anthropic/claude-opus-5' });
    expect(w.providers.ai_gateway.seen[0]).toMatchObject({ method: 'POST', path: '/v1/chat/completions', servername: 'ai-gateway.vercel.sh' });
    const call = w.chat.calls[0]!;
    expect(call.refusal).toBeNull();
    expect(call.headers['authorization']).toBe(`Bearer ${key}`);
    expect(call.headers['user-agent']).toMatch(/^fulcrumaxe-cloud/);
    expect(JSON.parse(call.bodyText)).toMatchObject({
      model: 'anthropic/claude-opus-5',
      max_tokens: 1024,
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'read_item', description: 'Read a work item', parameters: baseParams.tools[0]!.input_schema } }],
    });
  });

  it('a tool-result turn is sent as an assistant tool_calls message and role "tool" messages, and the fake accepts it', async () => {
    const t = await gw('result');
    w.chat.replies.push({ kind: 'stream', chunks: chatTurnChunks({ text: ['done'] }) });
    const messages = [
      { role: 'user' as const, content: 'look it up' },
      { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: 'call_1', name: 'read_item', input: { id: 'wi_42' } }] },
      { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 'call_1', content: '{"title":"x"}' }] },
    ];
    expect(await streamTurn(t.ctx, { ...gwParams, messages })).toMatchObject({ text: 'done', incomplete: false });
    const sent = JSON.parse(w.chat.calls[0]!.bodyText).messages;
    expect(sent[2]).toEqual({ role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_item', arguments: '{"id":"wi_42"}' } }] });
    expect(sent[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '{"title":"x"}' });
  });

  it('CC-5b-4: a body the real gateway would refuse fails the fake (unit and over the wire)', async () => {
    const known = new Set(['k']);
    const headers = { authorization: 'Bearer k', 'content-type': 'application/json', 'user-agent': 'ua' };
    const ok = { model: 'm', max_tokens: 5, messages: [{ role: 'user', content: 'x' }] };
    const check = (b: unknown, h: Record<string, string> = headers) => validateChatRequest(h, JSON.stringify(b), known);
    expect(check(ok)).toBeNull();
    expect(check({ ...ok, messages: undefined })?.message).toContain('messages');
    expect(check({ ...ok, messages: [] })?.message).toContain('messages');
    expect(check({ ...ok, tools: [{ type: 'function', function: { name: 'a' } }] })?.message).toContain('parameters');
    expect(check({ ...ok, tools: [{ type: 'function', function: { name: 'a', parameters: { type: 'string' } } }] })?.message).toContain('parameters');
    expect(check({ ...ok, stream_options: { include_usage: true } })?.message).toContain('stream_options');
    expect(check({ ...ok, max_tokens: 0 })?.status).toBe(400);
    expect(check({ ...ok, messages: [{ role: 'tool', tool_call_id: 'zz', content: 'x' }] })?.message).toContain('tool_call_id');
    expect(check({ ...ok, messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'n', arguments: '{}' } }] }, { role: 'user', content: 'x' }] })?.message).toContain('not answered');
    expect(check(ok, { ...headers, 'user-agent': '' })?.message).toContain('User-Agent');
    expect(check(ok, { ...headers, authorization: 'Bearer nope' })?.status).toBe(401);
    // Over the wire: a tool with no parameters surfaces as http_error 400 from the fake.
    const t = await gw('refuse');
    const err = await streamTurn(t.ctx, { ...gwParams, messages: [{ role: 'user' as const, content: 'x' }, { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 'ghost', content: 'x' }] }] }).catch((e) => e);
    expect(err).toMatchObject({ code: 'http_error', status: 400 });
    expect(w.chat.calls.at(-1)!.refusal).not.toBeNull();
  });

  it('chunks cut into 1, 3, 7 and 64 byte writes parse identically over TLS', async () => {
    const t = await gw('chunk');
    const results = [];
    for (const chunkBytes of [0, 1, 3, 7, 64]) {
      w.chat.chunkBytes = chunkBytes;
      w.chat.replies.push({ kind: 'stream', chunks: chatTurnChunks({ text: ['café ', '\u{1F600} done'], tools: [{ id: 'call_9', name: 'read_item', input: INPUT }] }) });
      results.push(await streamTurn(t.ctx, gwParams));
    }
    expect(results[0]).toMatchObject({ text: 'café \u{1F600} done', toolCalls: [{ id: 'call_9', name: 'read_item', input: INPUT }], incomplete: false });
    for (const r of results) expect(r).toEqual(results[0]);
  });

  describe('usage (CC-5b-2)', () => {
    it('usage arrives in the final chunk and is not marked estimated', async () => {
      const t = await gw('usage');
      w.chat.replies.push({ kind: 'stream', chunks: chatTurnChunks({ text: ['a'], promptTokens: 123, completionTokens: 45 }) });
      const r = await streamTurn(t.ctx, gwParams);
      expect(r.usage).toEqual({ inputTokens: 123, outputTokens: 45 });
      expect(r.usageEstimated).toBeUndefined();
    });

    it('a stream with no usage chunk is metered at the worst case: the full output allowance and the request size as input', async () => {
      const t = await gw('nousage');
      w.chat.replies.push({ kind: 'stream', chunks: chatTurnChunks({ text: ['a'], noUsage: true }) });
      const r = await streamTurn(t.ctx, { ...gwParams, maxOutputTokens: 777 });
      const sentBytes = Buffer.byteLength(w.chat.calls[0]!.bodyText);
      expect(r.usageEstimated).toBe(true);
      expect(r.usage.outputTokens).toBe(777);
      expect(r.usage.inputTokens).toBeGreaterThan(0);
      expect(r.usage.inputTokens).toBeLessThanOrEqual(sentBytes + TOOL_PREAMBLE_OVERHEAD_TOKENS);
      // The fixed tool-preamble allowance is on top of the request's own size, so a small tool request is never metered low.
      expect(r.usage.inputTokens).toBeGreaterThanOrEqual(TOOL_PREAMBLE_OVERHEAD_TOKENS);
      expect(r).toMatchObject({ text: 'a', incomplete: false });
    });
  });

  describe('errors and key hygiene (the same cases as the Anthropic shape)', () => {
    it('401 marks the connection broken; 403 too', async () => {
      const t = await gw('e401');
      w.chat.replies.push({ kind: 'status', status: 401, errorType: 'authentication_error' });
      await expect(streamTurn(t.ctx, gwParams)).rejects.toMatchObject({ code: 'key_rejected', status: 401 });
      expect(await w.connectionStatus(t.accountId)).toBe('broken');
    });

    it('the credits-exhausted answer gives credits_exhausted', async () => {
      const t = await gw('credits');
      const answer = CREDITS_EXHAUSTED_ANSWERS.find((a) => a.provider === 'ai_gateway')!;
      const body = answer.body as { error: { type: string; message: string } };
      w.chat.replies.push({ kind: 'status', status: answer.status, errorType: body.error.type, message: body.error.message });
      await expect(streamTurn(t.ctx, gwParams)).rejects.toMatchObject({ code: 'credits_exhausted' });
    });

    it('429 with retry-after is http_error and leaves the key alone', async () => {
      const t = await gw('e429');
      w.chat.replies.push({ kind: 'status', status: 429, errorType: 'rate_limit_error' });
      await expect(streamTurn(t.ctx, gwParams)).rejects.toMatchObject({ code: 'http_error', status: 429 });
      expect(await w.connectionStatus(t.accountId)).not.toBe('broken');
    });

    it('a mid-stream error chunk ends the turn with the fixed stream_error code; provider words and the key are not echoed', async () => {
      const key = fakeKey('api03', 'mid');
      const t = await w.tenant(key, 'ai_gateway');
      const chunks = [...chatTurnChunks({ text: ['partial'] }).slice(0, 3), { error: { type: 'overloaded_error', message: `Overloaded for ${key} see https://example.invalid/x` } }];
      w.chat.replies.push({ kind: 'stream', chunks });
      const err = await streamTurn(t.ctx, gwParams).catch((e) => e);
      expect(err).toMatchObject({ code: 'stream_error' });
      expect(err.message).toContain('overloaded_error');
      expect(`${err.message}${err.stack}`).not.toContain(key.slice(0, 12));
      expect(err.message).not.toContain('example.invalid');
      w.chat.replies.push({ kind: 'stream', chunks: [{ error: { type: 'weird secret_thing', message: 'm' } }] });
      expect((await streamTurn(t.ctx, gwParams).catch((e) => e)).message).toContain('(unknown)');
    });

    it('a provider error body that echoes the key is redacted, also across the truncation cut', async () => {
      const key = fakeKey('api03', 'echo');
      const t = await w.tenant(key, 'ai_gateway');
      for (const pad of [0, 470]) {
        w.chat.replies.push({ kind: 'status', status: 400, errorType: 'invalid_request_error', message: 'x'.repeat(pad) + ` bad key ${key} ` + 'y'.repeat(2000) });
        const err = await streamTurn(t.ctx, gwParams).catch((e) => e);
        expect(err).toBeInstanceOf(ModelCallError);
        expect(`${err.message}${err.stack}${JSON.stringify(err)}`).not.toContain(key.slice(0, 12));
        expect(err.message.length).toBeLessThan(700);
      }
    });

    it('a good turn leaks the key into no result field, request body, log line or console output; it travels only in the Authorization header', async () => {
      const key = fakeKey('api03', 'clean');
      const t = await w.tenant(key, 'ai_gateway');
      const sinks = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn'), vi.spyOn(process.stdout, 'write'), vi.spyOn(process.stderr, 'write')];
      w.chat.replies.push({ kind: 'stream', chunks: chatTurnChunks({ text: ['fine'], tools: [{ id: 'c1', name: 'read_item', input: { id: 'a' } }] }) });
      const r = await streamTurn(t.ctx, gwParams);
      expect(JSON.stringify(r)).not.toContain(key);
      expect(w.chat.calls[0]!.bodyText).not.toContain(key);
      expect(w.chat.calls[0]!.headers['authorization']).toBe(`Bearer ${key}`);
      for (const s of sinks) for (const call of s.mock.calls) expect(JSON.stringify(call)).not.toContain(key);
    });

    it('an OAuth-shaped key sends nothing, and the fake log is empty', async () => {
      const t = await w.tenant(fakeKey('oat01', 'sub'), 'ai_gateway');
      await expect(streamTurn(t.ctx, gwParams)).rejects.toMatchObject({ code: 'subscription_credential' });
      expect(w.providers.seen()).toEqual([]);
      expect(w.chat.calls).toEqual([]);
    });

    it('a stream cut between chunks returns the text so far, marked incomplete, with no tool call', async () => {
      const t = await gw('cut');
      w.chat.replies.push({ kind: 'stream', chunks: chatTurnChunks({ text: ['early', ' more'] }), cutAfter: 2 });
      expect(await streamTurn(t.ctx, gwParams)).toMatchObject({ text: 'early', incomplete: true, toolCalls: [], endedBy: 'cut' });
    });
  });

  describe('providers with no streaming path (CWE-703)', () => {
    it('streamRequestFor returns null for openai, an OAuth kind name and an unknown or inherited provider name', () => {
      for (const p of ['openai', 'chatgpt_oauth', 'codex_access_token', 'nope', '', 'constructor', '__proto__']) expect(streamRequestFor(p, 'k', { ...baseParams, tools: [] })).toBeNull();
    });

    it.each(['openai_api_key', 'codex_access_token', 'chatgpt_oauth'] as const)('a real openai row of kind %s answers unsupported_provider, makes no network call and leaks no key', async (kind) => {
      const key = fakeKey('api03', `oa${kind.length}`);
      const t = await w.tenantOpenAi(key, kind);
      const err = await streamTurn(t.ctx, gwParams).catch((e) => e);
      expect(err).toBeInstanceOf(ModelCallError);
      expect(err).toMatchObject({ code: 'unsupported_provider' });
      expect(`${err.message}${err.stack}${JSON.stringify(err)}`).not.toContain(key.slice(0, 12));
      expect(w.providers.seen()).toEqual([]);
      expect(w.chat.calls).toEqual([]);
      expect(w.messages.calls).toEqual([]);
    });
  });

  describe('the price table (R-597-C2-5)', () => {
    it('maps gateway ids to the plan-data price ids and refuses an unknown id, including inherited names', () => {
      expect(gatewayPricedModel('anthropic/claude-sonnet-5')).toBe('sonnet-5');
      // No exact plan-data row for 5.5: never priced as its sibling.
      expect(gatewayPricedModel('anthropic/claude-sonnet-5.5')).toBeNull();
      expect(gatewayPricedModel('anthropic/claude-opus-5')).toBe('opus-5');
      // Every mapped id is a model the plan-data price source prices: a table entry cannot drift ahead of the prices.
      for (const id of ['anthropic/claude-haiku-4.5', 'anthropic/claude-sonnet-5', 'anthropic/claude-opus-5']) expect(isPriced('claude-code', gatewayPricedModel(id)!)).toBe(true);
      for (const id of ['openai/gpt-9', 'anthropic/claude-haiku-5', 'anthropic/claude-opus-5.5', '', 'constructor', '__proto__', 'toString']) expect(gatewayPricedModel(id)).toBeNull();
    });

    it('an unpriced model id answers unpriced_model before any request is sent', async () => {
      const t = await gw('unpriced');
      const err = await streamTurn(t.ctx, { ...baseParams, model: 'openai/gpt-9' }).catch((e) => e);
      expect(err).toMatchObject({ code: 'unpriced_model' });
      expect(w.providers.seen()).toEqual([]);
      expect(w.chat.calls).toEqual([]);
    });
  });

  describe('the stream byte ceiling (#689 carry-over)', () => {
    it('clampStreamBytes never returns more than 4 MB, and falls back to the ceiling for junk', () => {
      const MB4 = 4 * 1024 * 1024;
      expect(clampStreamBytes(undefined)).toBe(MB4);
      expect(clampStreamBytes(1000)).toBe(1000);
      for (const v of [MB4 + 1, Number.MAX_SAFE_INTEGER, Infinity, NaN, 0, -5]) expect(clampStreamBytes(v)).toBe(MB4);
    });

    it('a caller asking for a huge maxStreamBytes still ends an oversized stream at the 4 MB ceiling (both shapes)', async () => {
      const big = 'x'.repeat(4 * 1024 * 1024 + 1024);
      const g = await gw('cap');
      w.chat.replies.push({ kind: 'stream', chunks: chatTurnChunks({ text: [big] }) });
      expect(await streamTurn(g.ctx, { ...gwParams, maxStreamBytes: Number.MAX_SAFE_INTEGER })).toMatchObject({ endedBy: 'size_cap', incomplete: true, toolCalls: [] });
      const a = await w.tenant(fakeKey('api03', 'capa'));
      const { turnEvents } = await import('./helpers/streamWorld.js');
      w.messages.replies.push({ kind: 'stream', events: turnEvents({ text: [big] }) });
      expect(await streamTurn(a.ctx, { ...baseParams, maxStreamBytes: Infinity })).toMatchObject({ endedBy: 'size_cap', incomplete: true });
    });
  });
});
