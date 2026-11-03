import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { captureReports } from '../../model-connection/test/helpers/captureReports.js';
import { chatTurnChunks, planData, startWorld, turnEvents, usePlanData, type Person } from './helpers/assistantWorld.js';

/** Every 12-character slice of the key: a partial leak is a leak. */
const slices = (key: string) => Array.from({ length: key.length - 11 }, (_, i) => key.slice(i, i + 12));

/**
 * D#597 CC-5e (CC-5-7): with a recognisable key on the connection, no log line, event, error body or response body holds any part of it;
 * the fake provider saw it only in its auth header.
 */
describe('assistant messages: the key goes nowhere but the provider\'s auth header', () => {
  const saved = process.env.FX_PLAN_DATA;
  let w: Awaited<ReturnType<typeof startWorld>>;
  beforeAll(async () => {
    w = await startWorld();
    usePlanData(planData({ cap: 2 }));
  });
  afterEach(() => w.reset());
  afterAll(async () => {
    usePlanData(saved === undefined ? undefined : JSON.parse(saved));
    await w.stop();
  });

  function expectNoKey(p: Person, outputs: string[]): void {
    const hay = outputs.join('\n');
    for (const s of slices(p.key)) expect(hay.includes(s), `a slice of the key (${s.length} chars) leaked`).toBe(false);
  }

  it.each(['ai_gateway', 'anthropic'] as const)('%s: an answer with a tool round, both forms, and a provider refusal that echoes the key', async (provider) => {
    const p = await w.person({ provider });
    const reports = captureReports();
    const item = await w.item(p, 'a title');
    const m = w.providers.anthropic.messages;
    const c = w.providers.ai_gateway.chat;
    const script = () => {
      if (provider === 'anthropic') {
        m.replies.push({ kind: 'stream', events: turnEvents({ tools: [{ id: 'toolu_1', name: 'get_item', input: { item_id: item } }] }) });
        m.replies.push({ kind: 'stream', events: turnEvents({ text: ['Here you go.'] }) });
      } else {
        c.replies.push({ kind: 'stream', chunks: chatTurnChunks({ tools: [{ id: 'call_1', name: 'get_item', input: { item_id: item } }] }) });
        c.replies.push({ kind: 'stream', chunks: chatTurnChunks({ text: ['Here you go.'] }) });
      }
    };
    const body = { repo_id: p.repoId, work_item_id: item, messages: [{ role: 'user', content: 'Show it' }] };
    const outputs: string[] = [];
    script();
    outputs.push((await w.send(p, body)).text);
    script();
    outputs.push((await w.send(p, body, { stream: true })).text);

    // The provider refuses and its error body repeats the key (a 429 with the key in its message): the answer carries a fixed code only.
    const refusal = { kind: 'status' as const, status: 429, errorType: 'rate_limit_error', message: `slow down ${p.key}` };
    if (provider === 'anthropic') m.replies.push(refusal);
    else c.replies.push(refusal);
    const refused = await w.send(p, body);
    outputs.push(refused.text);
    expect(refused.json()).toMatchObject({ state: 'unavailable', code: 'http_error' });
    if (provider === 'anthropic') m.replies.push(refusal);
    else c.replies.push(refusal);
    outputs.push((await w.send(p, body, { stream: true })).text);

    expectNoKey(p, [...outputs, reports.everything()]);
    // The fake saw the key in its auth header and nowhere else: not in any request body.
    const calls = provider === 'anthropic' ? m.calls : c.calls;
    expect(calls.length).toBeGreaterThanOrEqual(6);
    for (const call of calls) {
      expect(call.bodyText.includes(p.key)).toBe(false);
      const auth = provider === 'anthropic' ? call.headers['x-api-key'] : call.headers['authorization'];
      expect(auth).toBe(provider === 'anthropic' ? p.key : `Bearer ${p.key}`);
      const elsewhere = Object.entries(call.headers).filter(([name, v]) => name !== 'x-api-key' && name !== 'authorization' && v.includes(p.key));
      expect(elsewhere).toEqual([]);
    }
  });

  it('a key the provider rejects (401) reaches the person as a fixed code, never the key', async () => {
    const p = await w.person();
    const reports = captureReports();
    w.providers.ai_gateway.knownKeys.delete(p.key);
    const body = { repo_id: p.repoId, messages: [{ role: 'user', content: 'hi' }] };
    const rejected = await w.send(p, body);
    expect(rejected.json()).toMatchObject({ state: 'unavailable', code: 'key_rejected' });
    expectNoKey(p, [rejected.text, reports.everything()]);
  });
});
