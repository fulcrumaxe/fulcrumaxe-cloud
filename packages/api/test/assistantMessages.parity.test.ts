import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { captureReports } from '../../model-connection/test/helpers/captureReports.js';
import { chatTurnChunks, planData, startWorld, usePlanData, type Person } from './helpers/assistantWorld.js';

const BARE = /\b(undefined|null)\b/;

/** D#597 CC-5e: the JSON form and the event stream give the same answer and refusals for the same person, and neither ever shows undefined or null as text. */
describe('assistant messages: JSON and stream parity, and no undefined or null text', () => {
  const saved = process.env.FX_PLAN_DATA;
  let w: Awaited<ReturnType<typeof startWorld>>;
  const chat = () => w.providers.ai_gateway.chat;
  beforeAll(async () => {
    w = await startWorld();
    usePlanData(planData({ cap: 2 }));
  });
  afterEach(() => {
    expect(w.providers.ai_gateway.refused).toEqual([]);
    w.reset();
    usePlanData(planData({ cap: 2 }));
  });
  afterAll(async () => {
    usePlanData(saved === undefined ? undefined : JSON.parse(saved));
    await w.stop();
  });

  /** Runs the same scenario once as JSON and once as a stream (fresh script each time) and returns both outcomes in one shape. */
  async function both(p: Person, script: () => void, body: () => unknown) {
    script();
    const json = await w.send(p, body());
    script();
    const stream = await w.send(p, body(), { stream: true });
    const events = stream.events();
    const done = events.find((e) => e.event === 'done')?.data ?? {};
    const text = events.filter((e) => e.event === 'text').map((e) => String(e.data.delta)).join('');
    const conv = events.find((e) => e.event === 'conversation')?.data.conversation_id;
    // Every byte of both answers: no bare undefined or null, and every event is one of the documented names.
    for (const raw of [json.text, stream.text]) expect(raw).not.toMatch(BARE);
    for (const e of events) expect(['conversation', 'text', 'tool', 'done']).toContain(e.event);
    const j = json.json();
    const strip = (o: Record<string, unknown>) => {
      const rest = { ...o };
      delete rest.conversation_id;
      return rest;
    };
    return { json: strip(j), stream: strip({ ...done, text }), streamConversation: conv, jsonConversation: j.conversation_id };
  }

  it('CC-5-5 and parity: ok with an empty tool result, no key, unpriced, budget reached and a provider refusal each give the same state, text and money on both forms', async () => {
    const p = await w.person();
    const itemId = await w.item(p, null);
    const ask = (extra: Record<string, unknown> = {}) => () => ({ repo_id: p.repoId, work_item_id: itemId, messages: [{ role: 'user', content: 'status?' }], ...extra });
    const tools = () => {
      chat().replies.push({ kind: 'stream', chunks: chatTurnChunks({ tools: [{ id: 'c1', name: 'list_corrections', input: { item_id: itemId } }, { id: 'c2', name: 'get_verdicts', input: { item_id: itemId } }, { id: 'c3', name: 'get_spec', input: { item_id: itemId } }, { id: 'c4', name: 'get_plan', input: {} }] }) });
      chat().replies.push({ kind: 'stream', chunks: chatTurnChunks({ text: ['Nothing yet.'] }) });
    };
    const ok = await both(p, tools, ask());
    expect(ok.json).toMatchObject({ state: 'ok', text: 'Nothing yet.' });
    expect(ok.stream).toEqual(ok.json);
    expect(ok.streamConversation).toBeTypeOf('string');

    const noKey = await w.person({ provider: null });
    const nk = await both(noKey, () => undefined, () => ({ repo_id: noKey.repoId, messages: [{ role: 'user', content: 'hi' }] }));
    expect(nk.json).toMatchObject({ state: 'no_key', code: 'assistant_no_key' });
    expect(nk.stream).toEqual(nk.json);

    const refused = await both(p, () => chat().replies.push({ kind: 'status', status: 401, errorType: 'authentication_error', message: 'bad key' }), ask());
    expect(refused.json).toMatchObject({ state: 'unavailable', code: 'key_rejected' });
    expect(refused.stream).toEqual(refused.json);

    usePlanData(planData({ cap: 2, priced: false }));
    const unpriced = await both(p, () => undefined, ask());
    expect(unpriced.json).toMatchObject({ state: 'unpriced', code: 'assistant_unpriced' });
    usePlanData(planData({ cap: null }));
    const off = await both(p, () => undefined, ask());
    expect(off.json).toMatchObject({ state: 'unconfigured', code: 'assistant_unconfigured' });
    expect(off.stream).toEqual(off.json);
    usePlanData(planData({ cap: 2, priced: false }));
    expect(unpriced.stream).toEqual(unpriced.json);

    usePlanData(planData({ cap: 0.00001 }));
    const broke = await both(p, () => undefined, ask());
    expect(broke.json).toMatchObject({ state: 'budget_reached' });
    expect(broke.stream).toEqual(broke.json);
  });

  it('every tool result the model was sent for an empty item is a fixed word, and another repo\'s item reads as not found', async () => {
    const p = await w.person();
    const other = await w.person();
    const mine = await w.item(p, null);
    const theirs = await w.item(other, 'secret title');
    chat().replies.push({ kind: 'stream', chunks: chatTurnChunks({ tools: [{ id: 'c1', name: 'list_corrections', input: { item_id: mine } }, { id: 'c2', name: 'get_verdicts', input: { item_id: mine } }, { id: 'c3', name: 'get_item', input: { item_id: theirs } }, { id: 'c4', name: 'get_item', input: { item_id: mine } }] }) });
    chat().replies.push({ kind: 'stream', chunks: chatTurnChunks({ text: ['done'] }) });
    await w.send(p, { repo_id: p.repoId, work_item_id: mine, messages: [{ role: 'user', content: 'check' }] });
    const sent = JSON.parse(chat().calls[1]!.bodyText) as { messages: Array<{ role: string; content: string }> };
    const results = sent.messages.filter((m) => m.role === 'tool').map((m) => m.content);
    expect(results).toHaveLength(4);
    expect(results[0]).toBe('no corrections');
    expect(results[1]).toBe('no verdicts yet');
    expect(results[2]).toBe('not found');
    expect(results[3]).toContain('title: (none)');
    for (const r of results) expect(r).not.toMatch(BARE);
    expect(JSON.stringify(sent)).not.toContain('secret title');
  });

  it('R-597-C3-3: an owner on a member\'s conversation is refused the same on both forms, before any event, with no error report', async () => {
    const owner = await w.person();
    const member = await w.addMember(owner, 'member');
    chat().replies.push({ kind: 'stream', chunks: chatTurnChunks({ text: ['hi'] }) });
    const started = (await w.send(member, { repo_id: member.repoId, messages: [{ role: 'user', content: 'x' }] })).json().conversation_id as string;
    const reports = captureReports();
    const body = { conversation_id: started, messages: [{ role: 'user', content: 'again' }] };
    const a = await w.send(owner, body);
    const b = await w.send(owner, body, { stream: true });
    expect([a.status, b.status]).toEqual([404, 404]);
    expect(b.contentType).toContain('application/json');
    expect(b.json().error.code).toBe(a.json().error.code);
    expect(b.text).not.toContain('event:');
    expect(reports.everything()).not.toMatch(/assistant\.stream|internal_error/);
    expect(w.calls()).toBe(1);
    expect((await w.conversation(started)).reserved).toBe(0);
  });

  it('CC-5-7 parity of refusals: an unknown conversation, another person\'s conversation, a malformed body and a foreign repo answer the same on both forms', async () => {
    const p = await w.person();
    const other = await w.person();
    chat().replies.push({ kind: 'stream', chunks: chatTurnChunks({ text: ['hi'] }) });
    const theirs = (await w.send(other, { repo_id: other.repoId, messages: [{ role: 'user', content: 'x' }] })).json().conversation_id as string;
    const msg = [{ role: 'user', content: 'x' }];
    const cases: Array<[string, unknown, number]> = [
      ['unknown conversation', { conversation_id: randomUUID(), messages: msg }, 404],
      ["another account's conversation", { conversation_id: theirs, messages: msg }, 404],
      ["another account's repo", { repo_id: other.repoId, messages: msg }, 404],
      ['no conversation and no repo', { messages: msg }, 422],
      ['last message from the assistant', { repo_id: p.repoId, messages: [{ role: 'assistant', content: 'x' }] }, 422],
      ['an unknown field', { repo_id: p.repoId, messages: msg, status: 'accepted' }, 422],
    ];
    for (const [name, body, status] of cases) {
      const a = await w.send(p, body);
      const b = await w.send(p, body, { stream: true });
      expect(a.status, name).toBe(status);
      expect(b.status, name).toBe(status);
      expect(b.contentType, name).toContain('application/json');
      expect(b.json().error.code, name).toBe(a.json().error.code);
    }
    expect(w.calls()).toBe(1); // only `other`'s own first message reached the provider
  });
});
