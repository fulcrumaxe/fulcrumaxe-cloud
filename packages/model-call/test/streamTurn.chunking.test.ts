import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { streamTurn } from '../src/index.js';
import { SseParser } from '../src/sse.js';
import { turnEvents, baseParams, fakeKey, startWorld } from './helpers/streamWorld.js';

const INPUT = { id: 'wi_é', note: 'quote " brace } comma , \\ end', emoji: '\u{1F600}' };
const script = () => turnEvents({ text: ['café ', '\u{1F600} done'], tools: [{ id: 'toolu_9', name: 'read_item', input: INPUT }] });

describe('streamTurn chunking', () => {
  let w: Awaited<ReturnType<typeof startWorld>>;
  beforeAll(async () => (w = await startWorld()));
  afterAll(async () => w.stop());
  afterEach(() => w.reset());

  it('CC-5a-2: over TLS, a stream cut into 1, 3, 7 and 64 byte writes parses identically to one write per event', async () => {
    const t = await w.tenant(fakeKey('api03', 'chunk'));
    const results = [];
    for (const chunkBytes of [0, 1, 3, 7, 64]) {
      w.messages.chunkBytes = chunkBytes;
      w.messages.replies.push({ kind: 'stream', events: script() });
      results.push(await streamTurn(t.ctx, baseParams));
    }
    expect(results[0]).toMatchObject({ text: 'café \u{1F600} done', toolCalls: [{ id: 'toolu_9', name: 'read_item', input: INPUT }], incomplete: false });
    for (const r of results) expect(r).toEqual(results[0]);
  });

  it('the parser yields the same events at every byte split, including inside a JSON string, a UTF-8 character and CRLF', () => {
    const wire = script().map((e) => `event: ${e.event}\r\ndata: ${JSON.stringify(e.data)}\r\n\r\n`).join('');
    const bytes = new TextEncoder().encode(wire);
    const whole = new SseParser().push(bytes);
    expect(whole).toHaveLength(script().length);
    for (let cut = 1; cut < bytes.length; cut++) {
      const p = new SseParser();
      expect([...p.push(bytes.slice(0, cut)), ...p.push(bytes.slice(cut))]).toEqual(whole);
    }
  });

  it('comments, unknown fields and an event with no data are tolerated', () => {
    const p = new SseParser();
    const out = p.push(new TextEncoder().encode(': keep-alive\n\nid: 7\nevent: ping\ndata: {"type":"ping"}\n\nretry: 5\n\n'));
    expect(out).toEqual([{ event: 'ping', data: '{"type":"ping"}' }]);
  });
});
