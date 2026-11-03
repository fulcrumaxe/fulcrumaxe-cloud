import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { streamTurn } from '../src/index.js';
import { CREDITS_EXHAUSTED_ANSWERS } from '../../model-connection/test/helpers/creditsAnswers.js';
import { baseParams, fakeKey, startWorld, turnEvents } from './helpers/streamWorld.js';

describe('streamTurn errors and states', () => {
  let w: Awaited<ReturnType<typeof startWorld>>;
  beforeAll(async () => (w = await startWorld()));
  afterAll(async () => w.stop());
  afterEach(() => w.reset());

  it('CC-5a-5: 401 marks the connection broken and answers key_rejected', async () => {
    const t = await w.tenant(fakeKey('api03', 'e401'));
    w.messages.replies.push({ kind: 'status', status: 401, errorType: 'authentication_error', message: 'invalid x-api-key' });
    await expect(streamTurn(t.ctx, baseParams)).rejects.toMatchObject({ code: 'key_rejected', status: 401 });
    expect(await w.connectionStatus(t.accountId)).toBe('broken');
  });

  it('CC-5a-5: the credits-exhausted answer gives credits_exhausted and records it', async () => {
    const t = await w.tenant(fakeKey('api03', 'credits'));
    const answer = CREDITS_EXHAUSTED_ANSWERS.find((a) => a.provider === 'anthropic')!;
    const body = answer.body as { error: { type: string; message: string } };
    w.messages.replies.push({ kind: 'status', status: answer.status, errorType: body.error.type, message: body.error.message });
    await expect(streamTurn(t.ctx, baseParams)).rejects.toMatchObject({ code: 'credits_exhausted' });
    expect(await w.connectionStatus(t.accountId)).toBe('broken');
  });

  it('429 with retry-after and 529 overloaded are http_error and leave the key alone', async () => {
    const t = await w.tenant(fakeKey('api03', 'e429'));
    w.messages.replies.push({ kind: 'status', status: 429, errorType: 'rate_limit_error' }, { kind: 'status', status: 529, errorType: 'overloaded_error' });
    await expect(streamTurn(t.ctx, baseParams)).rejects.toMatchObject({ code: 'http_error', status: 429 });
    await expect(streamTurn(t.ctx, baseParams)).rejects.toMatchObject({ code: 'http_error', status: 529 });
    expect(await w.connectionStatus(t.accountId)).not.toBe('broken');
  });

  it('CC-5a-5: a mid-stream error event ends the turn with the fixed stream_error code and the provider words are not echoed', async () => {
    const t = await w.tenant(fakeKey('api03', 'mid'));
    const events = [...turnEvents({ text: ['partial'] }).slice(0, 4), { event: 'error', data: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded, see https://example.invalid/secret' } } }];
    w.messages.replies.push({ kind: 'stream', events });
    const err = await streamTurn(t.ctx, baseParams).catch((e) => e);
    expect(err).toMatchObject({ code: 'stream_error' });
    expect(err.message).toContain('overloaded_error');
    expect(err.message).not.toContain('example.invalid');
    // An error type we do not know is reported as "unknown", never as the provider's text.
    w.messages.replies.push({ kind: 'stream', events: [{ event: 'error', data: { type: 'error', error: { type: 'weird secret_thing', message: 'm' } } }] });
    expect((await streamTurn(t.ctx, baseParams).catch((e) => e)).message).toContain('(unknown)');
  });

  it('a stream cut between events returns the text so far, marked incomplete, with no tool call', async () => {
    const t = await w.tenant(fakeKey('api03', 'cut'));
    const events = turnEvents({ text: ['one ', 'two '], tools: [{ id: 'toolu_1', name: 'read_item', input: { id: 'wi_1' } }] });
    // message_start, block_start, ping, delta, delta, block_stop, tool block_start, one json delta -- then the connection dies.
    w.messages.replies.push({ kind: 'stream', events, cutAfter: 8 });
    const r = await streamTurn(t.ctx, baseParams);
    expect(r).toMatchObject({ text: 'one two ', toolCalls: [], incomplete: true });
  });

  it('a stream cut inside an event (a half tool-call argument) never yields a half call', async () => {
    const t = await w.tenant(fakeKey('api03', 'halfcall'));
    const events = turnEvents({ tools: [{ id: 'toolu_1', name: 'read_item', input: { id: 'wi_1', pad: 'z'.repeat(30) } }] });
    w.messages.replies.push({ kind: 'stream', events, cutAfter: 4, cutMidEvent: true });
    expect(await streamTurn(t.ctx, baseParams)).toMatchObject({ toolCalls: [], incomplete: true });
  });

  it('a tool block closed with an argument string that is not JSON is dropped and the turn is incomplete', async () => {
    const t = await w.tenant(fakeKey('api03', 'badjson'));
    const events = turnEvents({ tools: [{ id: 'toolu_1', name: 'read_item', input: { id: 'wi_1' } }] });
    const broken = events.map((e) => (e.event === 'content_block_delta' ? { ...e, data: { ...(e.data as object), delta: { type: 'input_json_delta', partial_json: '{"id": ' } } } : e));
    w.messages.replies.push({ kind: 'stream', events: broken });
    expect(await streamTurn(t.ctx, baseParams)).toMatchObject({ toolCalls: [], incomplete: true });
  });

  it('a stream that ends before message_stop is incomplete, with the text so far', async () => {
    const t = await w.tenant(fakeKey('api03', 'hang'));
    w.messages.replies.push({ kind: 'stream', events: turnEvents({ text: ['early'] }).slice(0, 4) });
    expect(await streamTurn(t.ctx, baseParams)).toMatchObject({ text: 'early', incomplete: true });
  });

  it('CC-5a-6: an OAuth-shaped key sends nothing, and the fake log is empty', async () => {
    const t = await w.tenant(fakeKey('oat01', 'sub'));
    await expect(streamTurn(t.ctx, baseParams)).rejects.toMatchObject({ code: 'subscription_credential' });
    expect(w.providers.seen()).toEqual([]);
    expect(w.messages.calls).toEqual([]);
  });
});
