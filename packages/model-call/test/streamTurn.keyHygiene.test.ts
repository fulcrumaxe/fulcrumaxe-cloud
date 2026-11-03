import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ModelCallError, streamTurn } from '../src/index.js';
import { baseParams, fakeKey, startWorld, turnEvents } from './helpers/streamWorld.js';

describe('streamTurn key hygiene (extends boundary.test.ts)', () => {
  let w: Awaited<ReturnType<typeof startWorld>>;
  beforeAll(async () => (w = await startWorld()));
  afterAll(async () => w.stop());
  afterEach(() => {
    w.reset();
    vi.restoreAllMocks();
  });

  const dump = (e: unknown) => `${(e as Error).message}${(e as Error).stack}${JSON.stringify(e)}`;

  it('CC-5a-3: a provider error body that echoes the key is redacted, also across the truncation cut', async () => {
    const key = fakeKey('api03', 'echo');
    const t = await w.tenant(key);
    for (const pad of [0, 470]) {
      w.messages.replies.push({ kind: 'status', status: 400, errorType: 'invalid_request_error', message: 'x'.repeat(pad) + ` bad key ${key} ` + 'y'.repeat(2000) });
      const err = await streamTurn(t.ctx, baseParams).catch((e) => e);
      expect(err).toBeInstanceOf(ModelCallError);
      expect(err).toMatchObject({ code: 'http_error', status: 400 });
      expect(dump(err)).not.toContain(key.slice(0, 12));
      expect(err.message.length).toBeLessThan(700);
      if (pad === 0) expect(err.message).toContain('[redacted]');
    }
  });

  it('CC-5a-3: a mid-stream error event that echoes the key ends the turn with a fixed message', async () => {
    const key = fakeKey('api03', 'midecho');
    const t = await w.tenant(key);
    const events = [...turnEvents({ text: ['partial'] }).slice(0, 4), { event: 'error', data: { type: 'error', error: { type: 'overloaded_error', message: `Overloaded for ${key}` } } }];
    w.messages.replies.push({ kind: 'stream', events });
    const err = await streamTurn(t.ctx, baseParams).catch((e) => e);
    expect(err).toMatchObject({ code: 'stream_error' });
    expect(dump(err)).not.toContain(key.slice(0, 12));
    expect(err.message).not.toContain('Overloaded for');
  });

  it('CC-5a-3: a successful turn leaks the key into no result field, no log line and no console output; the key travels only in the header', async () => {
    const key = fakeKey('api03', 'clean');
    const t = await w.tenant(key);
    const sinks = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'info'), vi.spyOn(process.stdout, 'write'), vi.spyOn(process.stderr, 'write')];
    w.messages.replies.push({ kind: 'stream', events: turnEvents({ text: ['fine'], tools: [{ id: 'toolu_1', name: 'read_item', input: { id: 'a' } }] }) });
    const r = await streamTurn(t.ctx, baseParams);
    expect(JSON.stringify(r)).not.toContain(key);
    expect(w.messages.calls[0]!.bodyText).not.toContain(key);
    expect(w.messages.calls[0]!.headers['x-api-key']).toBe(key);
    for (const s of sinks) for (const call of s.mock.calls) expect(JSON.stringify(call)).not.toContain(key);
  });

  it('a consumer callback that throws surfaces a fixed error, not the callback text or the key', async () => {
    const key = fakeKey('api03', 'cb');
    const t = await w.tenant(key);
    w.messages.replies.push({ kind: 'stream', events: turnEvents({ text: ['x'] }) });
    const err = await streamTurn(t.ctx, { ...baseParams, onText: () => { throw new Error(`boom ${key}`); } }).catch((e) => e);
    expect(err).toMatchObject({ code: 'fetch_failed' });
    expect(dump(err)).not.toContain(key.slice(0, 12));
  });

  it('S2f: no database connection is held while the stream is read', async () => {
    const t = await w.tenant(fakeKey('api03', 'idle'));
    w.messages.replies.push({ kind: 'stream', events: turnEvents({ text: ['a', 'b'] }) });
    let busy = -1;
    await streamTurn(t.ctx, { ...baseParams, onText: () => (busy = t.ctx.pool.totalCount - t.ctx.pool.idleCount + (t.ctx.platformOpsPool.totalCount - t.ctx.platformOpsPool.idleCount)) });
    expect(busy).toBe(0);
  });
});
