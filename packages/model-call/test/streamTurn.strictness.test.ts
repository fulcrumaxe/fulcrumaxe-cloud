import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { streamTurn } from '../src/index.js';
import { baseParams, fakeKey, startWorld, turnEvents } from './helpers/streamWorld.js';

describe('streamTurn: tool_use blocks are held to the offered tools (CWE-20)', () => {
  let w: Awaited<ReturnType<typeof startWorld>>;
  beforeAll(async () => (w = await startWorld()));
  afterAll(async () => w.stop());
  afterEach(() => w.reset());

  const run = async (tools: Array<{ id: string; name: string; input: unknown }>) => {
    const t = await w.tenant(fakeKey('api03', 'strict'));
    w.messages.replies.push({ kind: 'stream', events: turnEvents({ tools }) });
    return streamTurn(t.ctx, baseParams);
  };
  const dropped = (reason: string, index = 0) => ({ code: 'tool_call_rejected', reason, index });

  it('a valid call (offered name, object input, unique non-empty id) still passes', async () => {
    const r = await run([{ id: 'toolu_1', name: 'read_item', input: { id: 'a' } }]);
    expect(r).toMatchObject({ toolCalls: [{ id: 'toolu_1', name: 'read_item', input: { id: 'a' } }], rejectedCalls: [], incomplete: false });
  });

  it('a tool that was never offered is dropped with a fixed code, and its name is not echoed', async () => {
    const r = await run([{ id: 'toolu_1', name: 'accept_correction', input: { id: 'x' } }]);
    expect(r.toolCalls).toEqual([]);
    expect(r.rejectedCalls).toEqual([dropped('unknown_tool')]);
    expect(JSON.stringify(r.rejectedCalls)).not.toContain('accept_correction');
  });

  it('an input that is a string, an array, a number or null is dropped as input_not_object', async () => {
    for (const input of ['str', [1], 5, null]) {
      const r = await run([{ id: 'toolu_1', name: 'read_item', input }]);
      expect({ input, calls: r.toolCalls, rej: r.rejectedCalls }).toEqual({ input, calls: [], rej: [dropped('input_not_object')] });
    }
  });

  it('an empty id is dropped as bad_id', async () => {
    const r = await run([{ id: '', name: 'read_item', input: { id: 'a' } }]);
    expect([r.toolCalls, r.rejectedCalls]).toEqual([[], [dropped('bad_id')]]);
  });

  it('a second block with an id already used in the turn is dropped as duplicate_id; the first stays', async () => {
    const r = await run([
      { id: 'toolu_1', name: 'read_item', input: { id: 'a' } },
      { id: 'toolu_1', name: 'read_item', input: { id: 'b' } },
    ]);
    expect(r.toolCalls).toEqual([{ id: 'toolu_1', name: 'read_item', input: { id: 'a' } }]);
    expect(r.rejectedCalls).toEqual([dropped('duplicate_id', 1)]);
  });

  it('an argument string that is not JSON is dropped as input_not_json and the turn is incomplete', async () => {
    const t = await w.tenant(fakeKey('api03', 'notjson'));
    const events = turnEvents({ tools: [{ id: 'toolu_1', name: 'read_item', input: { id: 'a' } }] }).map((e) =>
      e.event === 'content_block_delta' ? { ...e, data: { ...(e.data as object), delta: { type: 'input_json_delta', partial_json: '{"id": ' } } } : e,
    );
    w.messages.replies.push({ kind: 'stream', events });
    const r = await streamTurn(t.ctx, baseParams);
    expect([r.toolCalls, r.rejectedCalls, r.incomplete]).toEqual([[], [dropped('input_not_json')], true]);
  });
});

describe('streamTurn: wall-time deadline and byte cap', () => {
  let w: Awaited<ReturnType<typeof startWorld>>;
  beforeAll(async () => (w = await startWorld()));
  afterAll(async () => w.stop());
  afterEach(() => w.reset());

  it('an endless stream stops at the deadline (timeoutMs) with the text so far, incomplete, endedBy deadline', async () => {
    const t = await w.tenant(fakeKey('api03', 'endless'));
    w.messages.replies.push({ kind: 'stream', events: turnEvents({ text: ['so far'] }).slice(0, 4), endless: true });
    const started = Date.now();
    const r = await streamTurn(t.ctx, { ...baseParams, timeoutMs: 400 });
    expect(r).toMatchObject({ text: 'so far', toolCalls: [], incomplete: true, endedBy: 'deadline' });
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it('an oversized event stops at the byte cap: nothing from it is parsed, endedBy size_cap', async () => {
    const t = await w.tenant(fakeKey('api03', 'cap'));
    const events = [...turnEvents({ text: ['ok'] }).slice(0, 4), { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'z'.repeat(6000) } } }];
    w.messages.replies.push({ kind: 'stream', events });
    const r = await streamTurn(t.ctx, { ...baseParams, maxStreamBytes: 2000 });
    expect(r).toMatchObject({ incomplete: true, endedBy: 'size_cap' });
    expect(r.text).not.toContain('z');
  });

  it('a stream cut by the server reports endedBy cut; a finished one reports null', async () => {
    const t = await w.tenant(fakeKey('api03', 'cutcode'));
    w.messages.replies.push({ kind: 'stream', events: turnEvents({ text: ['a'] }), cutAfter: 4 }, { kind: 'stream', events: turnEvents({ text: ['a'] }) });
    expect((await streamTurn(t.ctx, baseParams)).endedBy).toBe('cut');
    expect((await streamTurn(t.ctx, baseParams)).endedBy).toBeNull();
  });
});
