import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { streamTurn } from '../src/index.js';
import { baseParams, fakeKey, startWorld, turnEvents } from './helpers/streamWorld.js';

const KEY = fakeKey('api03', 'contract');
const URL_ = 'https://api.anthropic.com/v1/messages';
const GOOD_HEADERS = { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'user-agent': 'contract-test/1' };
const toolUse = { type: 'tool_use', id: 'toolu_01', name: 'read_item', input: { id: 'a' } };
const GOOD = { model: 'claude-sonnet-5-5', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] };

describe('the strict Anthropic messages fake refuses what the real API refuses', () => {
  let w: Awaited<ReturnType<typeof startWorld>>;
  beforeAll(async () => {
    w = await startWorld();
    w.providers.anthropic.knownKeys.add(KEY);
  });
  afterAll(async () => w.stop());
  afterEach(() => w.reset());

  const post = async (body: unknown, headers: Record<string, string> = GOOD_HEADERS) => {
    const res = await w.providers.transport(URL_, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
    return { status: res.status, json: (await res.json().catch(() => null)) as { type?: string; request_id?: string; error: { type?: string; message: string } }, headers: res.headers };
  };
  const without = (name: string) => Object.fromEntries(Object.entries(GOOD_HEADERS).filter(([k]) => k !== name));

  it('CC-5a-4: a tool_result turn whose tool_use_id matches no earlier tool_use is refused and surfaces as http_error', async () => {
    const t = await w.tenant(fakeKey('api03', 'unknownid'));
    const messages = [
      { role: 'user' as const, content: 'go' },
      { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: 'toolu_01', name: 'read_item', input: {} }] },
      { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 'toolu_NOPE', content: 'x' }] },
    ];
    const err = await streamTurn(t.ctx, { ...baseParams, messages }).catch((e) => e);
    expect(err).toMatchObject({ code: 'http_error', status: 400 });
    expect(err.message).toMatch(/tool_result/);
    expect(w.messages.calls[0]!.refusal).toMatchObject({ status: 400, type: 'invalid_request_error' });
  });

  it('refuses each malformed request with the real 400 body shape, and records every call', async () => {
    const twoTools = { ...GOOD, tools: [{ name: 'a', input_schema: { type: 'object' } }, { name: 'a', input_schema: { type: 'object' } }] };
    const cases: Array<[string, unknown, RegExp]> = [
      ['not JSON', '{nope', /not valid JSON/],
      ['no model', { ...GOOD, model: undefined }, /model/],
      ['max_tokens 0', { ...GOOD, max_tokens: 0 }, /max_tokens/],
      ['max_tokens a string', { ...GOOD, max_tokens: '64' }, /max_tokens/],
      ['no messages', { ...GOOD, messages: [] }, /at least one message/],
      ['first role assistant', { ...GOOD, messages: [{ role: 'assistant', content: 'x' }] }, /first message/],
      ['unknown role', { ...GOOD, messages: [{ role: 'system', content: 'x' }] }, /role/],
      ['empty content', { ...GOOD, messages: [{ role: 'user', content: '' }] }, /non-empty/],
      ['bad tool name', { ...GOOD, tools: [{ name: 'has space', input_schema: { type: 'object' } }] }, /tools\.0\.name/],
      ['duplicate tool names', twoTools, /unique/],
      ['tool schema not an object', { ...GOOD, tools: [{ name: 'a', input_schema: { type: 'string' } }] }, /input_schema/],
      ['stream not a boolean', { ...GOOD, stream: 'yes' }, /stream/],
      ['tool_result with no tool_use before it', { ...GOOD, messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'x' }] }] }, /unexpected tool_use_id/],
      ['tool_use left unanswered', { ...GOOD, messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: [toolUse] }, { role: 'user', content: 'no result' }] }, /without tool_result/],
      ['tool_use as the last message', { ...GOOD, messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: [toolUse] }] }, /unanswered/],
      ['tool_result after text', { ...GOOD, messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: [toolUse] }, { role: 'user', content: [{ type: 'text', text: 'hm' }, { type: 'tool_result', tool_use_id: 'toolu_01', content: 'x' }] }] }, /first in the content/],
    ];
    for (const [name, body, message] of cases) {
      const r = await post(body);
      expect({ name, status: r.status, type: r.json?.type, errorType: r.json?.error?.type }).toEqual({ name, status: 400, type: 'error', errorType: 'invalid_request_error' });
      expect(r.json.error.message, name).toMatch(message);
      expect(r.json.request_id, name).toMatch(/^req_/);
    }
    expect(w.messages.calls).toHaveLength(cases.length);
    expect(w.messages.calls.every((c) => c.refusal !== null)).toBe(true);
  });

  it('refuses a missing or unknown key (401 authentication_error), a missing anthropic-version, a wrong content-type and a missing User-Agent', async () => {
    const unknownKey = await post(GOOD, { ...GOOD_HEADERS, 'x-api-key': fakeKey('api03', 'unknown') });
    const noKey = await post(GOOD, without('x-api-key'));
    expect([unknownKey.status, unknownKey.json.error.type, noKey.status]).toEqual([401, 'authentication_error', 401]);
    const noVersion = await post(GOOD, without('anthropic-version'));
    const noType = await post(GOOD, { ...GOOD_HEADERS, 'content-type': 'text/plain' });
    const noAgent = await post(GOOD, without('user-agent'));
    expect([noVersion.status, noType.status, noAgent.status]).toEqual([400, 400, 400]);
    expect(noVersion.json.error.message).toMatch(/anthropic-version/);
    expect(noAgent.json.error.message).toMatch(/User-Agent/);
  });

  it('accepts a valid tool round trip, streams real SSE, and answers 429 with retry-after', async () => {
    w.messages.replies.push({ kind: 'stream', events: turnEvents({ text: ['hi'] }) }, { kind: 'status', status: 429, errorType: 'rate_limit_error' });
    const ok = await w.providers.transport(URL_, { method: 'POST', headers: GOOD_HEADERS, body: JSON.stringify({ ...GOOD, tools: [{ name: 'read_item', input_schema: { type: 'object' } }] }) });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toMatch(/^text\/event-stream/);
    const text = await ok.text();
    expect(text.startsWith('event: message_start\ndata: {')).toBe(true);
    expect(text).toMatch(/event: content_block_delta\ndata: .*text_delta/);
    expect(text.endsWith('event: message_stop\ndata: {"type":"message_stop"}\n\n')).toBe(true);
    const limited = await post(GOOD);
    expect([limited.status, limited.headers.get('retry-after'), limited.json.error.type]).toEqual([429, '7', 'rate_limit_error']);
  });

  it('an accepted request with nothing scripted fails loudly (500 and counted), and the route is off unless enabled', async () => {
    const r = await post(GOOD);
    expect(r.status).toBe(500);
    expect(w.messages.unscripted).toBe(1);
    w.providers.anthropic.messages.enabled = false;
    expect((await post(GOOD)).status).toBe(405);
    expect(w.providers.refused()).toHaveLength(1);
    w.providers.anthropic.messages.enabled = true;
    w.providers.anthropic.refused.length = 0;
  });
});
